use futures_util::StreamExt;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};

#[derive(Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
}

// One channel event type shared by both workers (HTTP model and local CLI), so the
// frontend handles streaming the same way regardless of where text comes from.
#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "lowercase")]
enum StreamEvent {
    Delta { text: String },
    // Chain-of-thought from reasoning models (DashScope QwQ/qwen reasoning, DeepSeek-R1, …) which
    // stream it in a separate `delta.reasoning_content` field, ahead of the actual answer `content`.
    Reasoning { text: String },
    Video { url: String },
    // Token usage from the final stream chunk. `cached` is the prompt portion served from the
    // provider's own context cache (DeepSeek: prompt_cache_hit_tokens; OpenAI: cached_tokens).
    Usage {
        prompt: u64,
        completion: u64,
        cached: u64,
    },
    Done,
    Error { message: String },
}

// Reuse one HTTP client across streaming calls so sequential pipeline steps to the same
// provider can reuse connections. Only for commands on tauri's own async runtime —
// video_generate runs on its own runtime and keeps a separate client, since a reqwest
// client's connection pool is bound to the runtime it was first used on.
fn http_client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(reqwest::Client::new)
}

// Stream a chat completion from any OpenAI-compatible endpoint (DeepSeek today;
// Kimi / Qwen / OpenAI / Volcengine share the same shape, only base_url + key differ).
#[tauri::command]
async fn chat_stream(
    url: String,
    api_key: String,
    model: String,
    messages: Vec<ChatMessage>,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    let body = serde_json::json!({
        "model": model,
        "messages": messages
            .iter()
            .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
            .collect::<Vec<_>>(),
        "stream": true,
        // Ask OpenAI-compatible endpoints to append a final chunk carrying token usage.
        // DeepSeek/Kimi/Qwen/Volcengine/OpenAI all honor this; the chunk has empty `choices`.
        "stream_options": { "include_usage": true },
    });

    let client = http_client();
    let resp = match client
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            let _ = on_event.send(StreamEvent::Error { message: e.to_string() });
            return Ok(());
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let _ = on_event.send(StreamEvent::Error {
            message: format!("HTTP {status}: {text}"),
        });
        return Ok(());
    }

    // Accumulate raw bytes and split on '\n'. A full SSE "data:" line is complete
    // before we parse it, so multi-byte UTF-8 chars never straddle a parse boundary.
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                let _ = on_event.send(StreamEvent::Error { message: e.to_string() });
                return Ok(());
            }
        };
        buf.extend_from_slice(&chunk);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line_bytes);
            let line = line.trim();
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data == "[DONE]" {
                let _ = on_event.send(StreamEvent::Done);
                return Ok(());
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                let delta = &v["choices"][0]["delta"];
                // Reasoning trace (if any) streams before the answer; forward it on its own channel
                // so the UI can show it collapsed instead of mixing it into the answer text.
                if let Some(r) = delta["reasoning_content"].as_str() {
                    if !r.is_empty() {
                        let _ = on_event.send(StreamEvent::Reasoning { text: r.to_string() });
                    }
                }
                if let Some(t) = delta["content"].as_str() {
                    if !t.is_empty() {
                        let _ = on_event.send(StreamEvent::Delta { text: t.to_string() });
                    }
                }
                // Final chunk carries token counts. DeepSeek reports the cache-hit portion as
                // prompt_cache_hit_tokens; OpenAI nests it under prompt_tokens_details.cached_tokens.
                let u = &v["usage"];
                if u.is_object() {
                    let prompt = u["prompt_tokens"].as_u64().unwrap_or(0);
                    let completion = u["completion_tokens"].as_u64().unwrap_or(0);
                    let cached = u["prompt_cache_hit_tokens"]
                        .as_u64()
                        .or_else(|| u["prompt_tokens_details"]["cached_tokens"].as_u64())
                        .unwrap_or(0);
                    if prompt > 0 || completion > 0 {
                        let _ = on_event.send(StreamEvent::Usage {
                            prompt,
                            completion,
                            cached,
                        });
                    }
                }
            }
        }
    }
    let _ = on_event.send(StreamEvent::Done);
    Ok(())
}

// Strip HTML down to readable text so a page can be fed to a model for rewriting.
// UTF-8 safe (operates on chars / str slices), so Chinese pages come through intact.
fn html_to_text(html: &str) -> String {
    // Cap input so a huge page can't make this expensive.
    let mut s: String = if html.chars().count() > 500_000 {
        html.chars().take(500_000).collect()
    } else {
        html.to_string()
    };
    // Drop non-content blocks entirely.
    for tag in ["script", "style", "noscript", "svg", "head", "iframe"] {
        let open = format!("<{tag}");
        let close = format!("</{tag}>");
        loop {
            let lower = s.to_lowercase();
            let Some(start) = lower.find(&open) else {
                break;
            };
            match lower[start..].find(&close) {
                Some(rel) => {
                    let end = start + rel + close.len();
                    s.replace_range(start..end, " ");
                }
                None => {
                    s.replace_range(start.., " ");
                    break;
                }
            }
        }
    }
    // Strip remaining tags; emit a space where each was so words don't fuse together.
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let out = out
        .replace("&nbsp;", " ")
        .replace("&#160;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&rsquo;", "'")
        .replace("&ldquo;", "\"")
        .replace("&rdquo;", "\"");
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

// Fetch a URL and return its readable text, for "read a link and rewrite the article".
#[tauri::command]
async fn fetch_url(url: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        )
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let html = resp.text().await.map_err(|e| e.to_string())?;
    let text = html_to_text(&html);
    if text.trim().is_empty() {
        return Err("抓到页面但没解析出正文（可能是纯 JS 渲染的站点）".to_string());
    }
    Ok(text)
}

// Text-to-image (Volcengine Ark / Seedream shape, OpenAI-images compatible). Synchronous:
// Decode a reference image (a `data:image/...;base64,...` URL or an http(s) URL) into raw bytes
// + its MIME type — used by image-to-image (multipart upload to OpenAI's /images/edits).
async fn load_image_bytes(src: &str, client: &reqwest::Client) -> Result<(Vec<u8>, String), String> {
    if let Some(rest) = src.strip_prefix("data:") {
        let (meta, data) = rest.split_once(',').ok_or("bad data URL")?;
        let mime = meta.split(';').next().unwrap_or("image/png").to_string();
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.trim())
            .map_err(|e| e.to_string())?;
        Ok((bytes, mime))
    } else {
        let r = client.get(src).send().await.map_err(|e| e.to_string())?;
        let mime = r
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("image/png")
            .to_string();
        let bytes = r.bytes().await.map_err(|e| e.to_string())?.to_vec();
        Ok((bytes, mime))
    }
}

// POST a prompt, get back one image URL (or base64). No polling, unlike video.
// `image` (optional) turns this into image-to-image: for OpenAI endpoints it switches to the
// multipart /images/edits API; for everything else (Volcengine Seedream et al.) it adds an
// `image` field to the JSON body. Callers asking for multiple images just call this N times.
#[tauri::command]
async fn image_generate(
    endpoint: String,
    api_key: String,
    model: String,
    prompt: String,
    size: String,
    image: Option<String>,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;
    let ref_img = image.unwrap_or_default();
    let is_i2i = !ref_img.trim().is_empty();
    let is_openai = endpoint.contains("openai.com") || endpoint.contains("/images/edits");

    let resp = if is_i2i && is_openai {
        // OpenAI image-to-image: multipart upload to /images/edits.
        let edits_url = endpoint.replace("/images/generations", "/images/edits");
        let (bytes, mime) = load_image_bytes(&ref_img, &client).await?;
        let ext = mime.rsplit('/').next().unwrap_or("png");
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(format!("image.{ext}"))
            .mime_str(&mime)
            .map_err(|e| e.to_string())?;
        let mut form = reqwest::multipart::Form::new()
            .text("model", model)
            .text("prompt", prompt)
            .part("image", part);
        if !size.trim().is_empty() {
            form = form.text("size", size);
        }
        client
            .post(&edits_url)
            .header("Authorization", format!("Bearer {api_key}"))
            .multipart(form)
            .send()
            .await
    } else {
        // text-to-image, or Seedream-style image-to-image (reference image in the JSON body).
        let mut body = serde_json::json!({
            "model": model,
            "prompt": prompt,
            "response_format": "url",
            "watermark": false,
        });
        if !size.trim().is_empty() {
            body["size"] = serde_json::json!(size);
        }
        if is_i2i {
            body["image"] = serde_json::json!(ref_img);
        }
        client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {api_key}"))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
    }
    .map_err(|e| e.to_string())?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {status}: {text}"));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if let Some(url) = v["data"][0]["url"].as_str() {
        if !url.is_empty() {
            return Ok(url.to_string());
        }
    }
    if let Some(b64) = v["data"][0]["b64_json"].as_str() {
        if !b64.is_empty() {
            return Ok(format!("data:image/png;base64,{b64}"));
        }
    }
    Err(format!("没解析出图片 url：{text}"))
}

// Submit an async video-generation task (Volcengine Ark / Seedance shape) and poll
// until it finishes, streaming status to the frontend and finally the video URL.
// Runs on its own current-thread tokio runtime so it doesn't depend on tauri's
// runtime feature flags.
#[tauri::command]
fn video_generate(
    endpoint: String, // create-task URL, .../api/v3/contents/generations/tasks
    api_key: String,
    model: String,
    prompt: String,
    resolution: String,
    ratio: String,
    duration: u32,
    on_event: Channel<StreamEvent>,
) {
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(r) => r,
            Err(e) => {
                let _ = on_event.send(StreamEvent::Error { message: e.to_string() });
                return;
            }
        };
        rt.block_on(async move {
            let client = reqwest::Client::new();
            let base = endpoint.trim_end_matches('/').to_string();
            let auth = format!("Bearer {api_key}");

            let mut body = serde_json::json!({
                "model": model,
                "content": [{ "type": "text", "text": prompt }],
            });
            if !resolution.trim().is_empty() {
                body["resolution"] = serde_json::json!(resolution);
            }
            if !ratio.trim().is_empty() {
                body["ratio"] = serde_json::json!(ratio);
            }
            if duration > 0 {
                body["duration"] = serde_json::json!(duration);
            }

            // create task
            let resp = match client.post(&base).header("Authorization", &auth).json(&body).send().await {
                Ok(r) => r,
                Err(e) => {
                    let _ = on_event.send(StreamEvent::Error { message: e.to_string() });
                    return;
                }
            };
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            if !status.is_success() {
                let _ = on_event.send(StreamEvent::Error { message: format!("HTTP {status}: {text}") });
                return;
            }
            let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::json!({}));
            let id = v["id"].as_str().unwrap_or("").to_string();
            if id.is_empty() {
                let _ = on_event.send(StreamEvent::Error { message: format!("未拿到任务 id：{text}") });
                return;
            }
            let _ = on_event.send(StreamEvent::Delta { text: format!("任务已提交：{id}\n排队中…\n") });

            // poll up to ~12 min (240 * 3s)
            let task_url = format!("{base}/{id}");
            let mut last = String::new();
            for _ in 0..240 {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                let r = match client.get(&task_url).header("Authorization", &auth).send().await {
                    Ok(r) => r,
                    Err(_) => continue, // transient network error: keep polling
                };
                let t = r.text().await.unwrap_or_default();
                let jv: serde_json::Value = serde_json::from_str(&t).unwrap_or(serde_json::json!({}));
                let st = jv["status"].as_str().unwrap_or("").to_string();
                match st.as_str() {
                    "succeeded" => {
                        let url = jv["content"]["video_url"].as_str().unwrap_or("");
                        if url.is_empty() {
                            let _ = on_event.send(StreamEvent::Error { message: format!("成功但没有 video_url：{t}") });
                        } else {
                            let _ = on_event.send(StreamEvent::Video { url: url.to_string() });
                            let _ = on_event.send(StreamEvent::Done);
                        }
                        return;
                    }
                    "failed" | "expired" | "cancelled" => {
                        let em = jv["error"]["message"].as_str().unwrap_or(&st);
                        let _ = on_event.send(StreamEvent::Error { message: format!("任务 {st}：{em}") });
                        return;
                    }
                    other => {
                        // only emit when the status actually changes, to avoid spam
                        if other != last {
                            last = other.to_string();
                            let label = if other.is_empty() { "处理中" } else { other };
                            let _ = on_event.send(StreamEvent::Delta { text: format!("{label}…\n") });
                        }
                    }
                }
            }
            let _ = on_event.send(StreamEvent::Error { message: "轮询超时（12 分钟还没生成完）".to_string() });
        });
    });
}

// A bundled .app launched from Finder inherits only a minimal PATH, so the user's
// node/claude (nvm/homebrew/custom) is missing. Resolve the real PATH once from the
// login shell. Cached for the process lifetime.
fn full_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let home = std::env::var("HOME").unwrap_or_default();
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let from_shell = std::process::Command::new(&shell)
            .args(["-lic", "printf '__COUNCIL__%s' \"$PATH\""])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()
            .and_then(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .split("__COUNCIL__")
                    .nth(1)
                    .map(|p| p.trim().to_string())
            })
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());
        format!("{home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:{from_shell}")
    })
}

// Resolve a bare program name to an absolute path so it works even when the app is
// launched from Finder (no shell PATH). CLI agents often live in ~/.local/bin.
fn resolve_program(program: &str) -> String {
    if program.contains('/') {
        return program.to_string();
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let mut dirs = vec![format!("{home}/.local/bin")];
    dirs.extend(full_path().split(':').map(|s| s.to_string()));
    for d in dirs {
        let cand = Path::new(&d).join(program);
        if cand.is_file() {
            return cand.to_string_lossy().to_string();
        }
    }
    program.to_string()
}

fn expand_home_path(path: &str) -> String {
    let p = path.trim();
    if p == "~" {
        return std::env::var("HOME").unwrap_or_default();
    }
    if let Some(rest) = p.strip_prefix("~/") {
        return Path::new(&std::env::var("HOME").unwrap_or_default())
            .join(rest)
            .to_string_lossy()
            .to_string();
    }
    p.to_string()
}

// Run a local CLI agent headless and stream its stdout. The prompt is passed as the
// final argument (e.g. `claude -p <prompt>`, `codex exec <prompt>`), so any CLI that
// takes a one-shot prompt works — the user configures program + fixed args.
// `cwd` (optional) runs the agent inside a project folder, so several agents can edit
// the same codebase (协作编程 mode). Sync commands run on the main thread, so do the
// blocking work in a spawned thread and return immediately — the Channel streams on.
#[tauri::command]
fn cli_run(
    program: String,
    args: Vec<String>,
    prompt: String,
    cwd: Option<String>,
    on_event: Channel<StreamEvent>,
) {
    use std::process::{Command, Stdio};

    std::thread::spawn(move || {
        let cwd = cwd
            .as_deref()
            .filter(|d| !d.trim().is_empty())
            .map(expand_home_path);
        // If a working dir was given, it must exist — else the agent edits the wrong place.
        if let Some(dir) = cwd.as_deref() {
            if !Path::new(dir).is_dir() {
                let _ = on_event.send(StreamEvent::Error {
                    message: format!("项目文件夹不存在：{dir}"),
                });
                return;
            }
        }
        let mut cmd = Command::new(resolve_program(&program));
        for a in &args {
            cmd.arg(a);
        }
        cmd.arg(&prompt);
        if let Some(dir) = cwd.as_deref() {
            cmd.current_dir(dir);
        }
        let mut child = match cmd
            .env("PATH", full_path())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                let _ = on_event.send(StreamEvent::Error {
                    message: format!("启动 {program} 失败: {e}"),
                });
                return;
            }
        };

        // Drain stderr on its own thread so a chatty CLI can't fill the pipe and deadlock.
        let stderr_handle = child.stderr.take().map(|mut e| {
            std::thread::spawn(move || {
                let mut s = String::new();
                let _ = std::io::Read::read_to_string(&mut e, &mut s);
                s
            })
        });

        if let Some(out) = child.stdout.take() {
            let mut reader = BufReader::new(out);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let _ = on_event.send(StreamEvent::Delta { text: line.clone() });
                    }
                }
            }
        }

        let status = child.wait();
        let stderr = stderr_handle
            .and_then(|h| h.join().ok())
            .unwrap_or_default();
        match status {
            Ok(s) if s.success() => {
                let _ = on_event.send(StreamEvent::Done);
            }
            _ => {
                let msg = if stderr.trim().is_empty() {
                    format!("{program} 退出码非 0")
                } else {
                    stderr
                };
                let _ = on_event.send(StreamEvent::Error { message: msg });
            }
        }
    });
}

// ---- embedded terminals (终端 panel): interactive shells via a pseudo-terminal ----
struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
}
#[derive(Default)]
struct Ptys(Arc<Mutex<HashMap<String, PtySession>>>);

// Spawn a PTY running `program` (empty = the user's login $SHELL) in `cwd`, streaming
// raw output bytes to the frontend over a binary Channel. Ported from clink.
#[tauri::command]
fn spawn_pty(
    app: AppHandle,
    ptys: State<Ptys>,
    id: String,
    program: String,
    args: Vec<String>,
    cwd: String,
    cols: u16,
    rows: u16,
    on_data: Channel<tauri::ipc::Response>,
) -> Result<(), String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let prog = if program.trim().is_empty() {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    } else {
        resolve_program(&program)
    };
    let mut cmd = CommandBuilder::new(prog);
    for a in &args {
        cmd.arg(a);
    }
    cmd.cwd(if cwd.trim().is_empty() {
        std::env::var("HOME").unwrap_or_default()
    } else {
        expand_home_path(&cwd)
    });
    // Inherit the real login PATH (so node/claude/etc. resolve) + a sane TERM for TUIs.
    cmd.env("PATH", full_path());
    cmd.env("TERM", "xterm-256color");

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let map = ptys.0.clone();
    map.lock().unwrap().insert(id.clone(), PtySession { writer, master: pair.master });

    // Reader thread: stream raw bytes (binary, no UTF-8 decode — a multi-byte char can
    // straddle a read boundary). On EOF, drop the session and notify the frontend.
    let id_out = id;
    std::thread::spawn(move || {
        let mut buf = [0u8; 65536];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = on_data.send(tauri::ipc::Response::new(buf[..n].to_vec()));
                }
            }
        }
        map.lock().unwrap().remove(&id_out);
        let _ = app.emit(&format!("pty:exit:{id_out}"), ());
    });
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[tauri::command]
fn write_pty(ptys: State<Ptys>, id: String, data: String) -> Result<(), String> {
    if let Some(s) = ptys.0.lock().unwrap().get_mut(&id) {
        s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        s.writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn resize_pty(ptys: State<Ptys>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    if let Some(s) = ptys.0.lock().unwrap().get(&id) {
        s.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn close_pty(ptys: State<Ptys>, id: String) {
    // Dropping the master closes the PTY; the child receives SIGHUP.
    ptys.0.lock().unwrap().remove(&id);
}

// Is this path an existing directory? Lets 协作编程 confirm the project folder before
// turning agents loose on it. `~` is expanded to $HOME.
#[tauri::command]
fn dir_exists(path: String) -> bool {
    if path.trim().is_empty() {
        return false;
    }
    let expanded = expand_home_path(&path);
    Path::new(&expanded).is_dir()
}

// ---- HTTP 协作 Agent (API 模型作为主写/审查，无终端) 支持的文件操作 ----
// These let an HTTP chat model participate in 协作编程: read the shared TEAM_NOTES.md + a snapshot
// of the project, and (when it's the implementer) write whole files back. All writes are confined
// to the project dir.

#[tauri::command]
fn read_text_file(path: String) -> String {
    std::fs::read_to_string(expand_home_path(&path)).unwrap_or_default()
}

// Append a block to <dir>/TEAM_NOTES.md (created if missing), so HTTP agents share feedback the
// same way the CLI agents do.
#[tauri::command]
fn append_team_notes(dir: String, text: String) -> Result<(), String> {
    let path = Path::new(&expand_home_path(&dir)).join("TEAM_NOTES.md");
    let mut existing = std::fs::read_to_string(&path).unwrap_or_default();
    if !existing.is_empty() && !existing.ends_with('\n') {
        existing.push('\n');
    }
    existing.push_str(&text);
    if !existing.ends_with('\n') {
        existing.push('\n');
    }
    std::fs::write(&path, existing).map_err(|e| e.to_string())
}

// Directories/extensions a code snapshot should never descend into / include — keeps the snapshot
// small and free of build output, deps and binaries.
fn snapshot_skip_dir(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | "out"
            | ".next"
            | "vendor"
            | ".venv"
            | "venv"
            | "__pycache__"
            | "coverage"
            | ".cache"
            | ".idea"
            | ".vscode"
            | ".gstack"
    )
}
fn snapshot_skip_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    const BIN_EXT: &[&str] = &[
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tar", ".mp4",
        ".mov", ".mp3", ".wav", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".lock", ".dmg", ".so",
        ".dylib", ".a", ".o", ".class", ".wasm", ".bin",
    ];
    BIN_EXT.iter().any(|e| lower.ends_with(e))
}
fn walk_snapshot(dir: &Path, base: &Path, out: &mut String, budget: &mut usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        if *budget == 0 {
            return;
        }
        let path = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            if name.starts_with('.') && name != ".github" || snapshot_skip_dir(&name) {
                continue;
            }
            walk_snapshot(&path, base, out, budget);
        } else {
            if snapshot_skip_file(&name) {
                continue;
            }
            let Ok(meta) = e.metadata() else { continue };
            if meta.len() > 80_000 {
                continue; // skip very large files
            }
            let Ok(content) = std::fs::read_to_string(&path) else {
                continue; // non-UTF8 / binary
            };
            let rel = path.strip_prefix(base).unwrap_or(&path).to_string_lossy();
            let slice: String = content.chars().take(*budget).collect();
            *budget = budget.saturating_sub(slice.chars().count());
            out.push_str(&format!("\n===== {rel} =====\n{slice}\n"));
        }
    }
}
// Concatenate the project's text source files (path-headed) up to a char budget, for feeding an
// HTTP model enough context to review or edit the code.
#[tauri::command]
fn code_snapshot(dir: String, max_chars: usize) -> String {
    let base = std::path::PathBuf::from(expand_home_path(&dir));
    let mut out = String::new();
    let mut budget = max_chars.clamp(2_000, 400_000);
    walk_snapshot(&base, &base, &mut out, &mut budget);
    if out.is_empty() {
        out.push_str("（项目为空或无可读源码文件）");
    }
    out
}

// Reject path components that would escape the project dir; return the safe absolute path.
fn safe_join(dir: &Path, rel: &str) -> Result<std::path::PathBuf, String> {
    let rel = rel.trim().trim_start_matches(['/', '\\']);
    if rel.is_empty() {
        return Err("空路径".into());
    }
    let mut p = dir.to_path_buf();
    for comp in rel.split(['/', '\\']) {
        match comp {
            "" | "." => continue,
            ".." => return Err(format!("路径越界：{rel}")),
            c => p.push(c),
        }
    }
    if !p.starts_with(dir) {
        return Err(format!("路径越界：{rel}"));
    }
    Ok(p)
}
// Write a whole file inside the project dir (creating parent dirs). Used by the HTTP implementer
// agent to apply the model's proposed file contents.
#[tauri::command]
fn write_project_file(dir: String, rel: String, content: String) -> Result<(), String> {
    let base = std::path::PathBuf::from(expand_home_path(&dir));
    if !base.is_dir() {
        return Err(format!("项目目录不存在：{}", base.display()));
    }
    let target = safe_join(&base, &rel)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&target, content).map_err(|e| e.to_string())
}

// Image-to-file generation via an agentic CLI (grok / codex … have built-in image tools). Runs
// the CLI in a fresh temp dir with the given args + prompt, waits for it to finish, then returns
// the image file paths it saved. The frontend converts those paths with convertFileSrc, avoiding
// slow base64 encoding and large IPC payloads for multi-image runs.
#[tauri::command]
fn cli_gen_images(
    program: String,
    args: Vec<String>,
    prompt: String,
    count: Option<u32>,
) -> Result<Vec<String>, String> {
    use std::process::{Command, Stdio};
    use std::time::{SystemTime, UNIX_EPOCH};
    let want = count.unwrap_or(1).clamp(1, 4) as usize;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = std::env::temp_dir();
    if let Ok(rd) = std::fs::read_dir(&tmp) {
        let cutoff = SystemTime::now()
            .checked_sub(std::time::Duration::from_secs(24 * 60 * 60))
            .unwrap_or(UNIX_EPOCH);
        for e in rd.flatten() {
            let p = e.path();
            let Some(name) = p.file_name().and_then(|x| x.to_str()) else {
                continue;
            };
            if !name.starts_with("council_genimg_") || !p.is_dir() {
                continue;
            }
            let modified = e
                .metadata()
                .and_then(|md| md.modified())
                .unwrap_or(UNIX_EPOCH);
            if modified < cutoff {
                let _ = std::fs::remove_dir_all(p);
            }
        }
    }
    let dir = tmp.join(format!("council_genimg_{ts}"));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(resolve_program(&program));
    for a in &args {
        cmd.arg(a);
    }
    // Guard against argv flag-smuggling: a prompt starting with '-' could be parsed as a CLI flag.
    // Prepending a space keeps it a plain positional/value (harmless leading space in an image
    // description) without changing the per-CLI invocation structure.
    let safe_prompt = if prompt.starts_with('-') {
        format!(" {prompt}")
    } else {
        prompt
    };
    cmd.arg(&safe_prompt);
    // Timestamp the run so we can later tell which images in a CLI's own output dir (below) this
    // invocation produced, vs. ones left over from earlier sessions.
    let start = SystemTime::now();
    let out = cmd
        .current_dir(&dir)
        .env("PATH", full_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| e.to_string())?;
    // Find the newest image file anywhere under the temp dir.
    let exts = ["png", "jpg", "jpeg", "webp", "gif"];
    let mut found: Vec<(SystemTime, std::path::PathBuf)> = Vec::new();
    let mut stack = vec![dir.clone()];
    while let Some(d) = stack.pop() {
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                    continue;
                }
                let ext = p
                    .extension()
                    .and_then(|x| x.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                if exts.contains(&ext.as_str()) {
                    let m = e
                        .metadata()
                        .and_then(|md| md.modified())
                        .unwrap_or(UNIX_EPOCH);
                    found.push((m, p));
                }
            }
        }
    }
    // Some CLIs (notably codex's `imagegen` skill) ignore "save to the current directory" and write
    // to their own fixed location (~/.codex/generated_images/<session>/<id>.png), so the cwd scan
    // above comes up empty even though an image WAS generated. If short, pull in images that dir
    // produced during this run (mtime >= start guards against grabbing earlier sessions' files).
    if found.len() < want {
        let home = std::env::var("HOME").unwrap_or_default();
        let mut stack = vec![Path::new(&home).join(".codex/generated_images")];
        while let Some(d) = stack.pop() {
            if let Ok(rd) = std::fs::read_dir(&d) {
                for e in rd.flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        stack.push(p);
                        continue;
                    }
                    let ext = p
                        .extension()
                        .and_then(|x| x.to_str())
                        .unwrap_or("")
                        .to_lowercase();
                    if !exts.contains(&ext.as_str()) {
                        continue;
                    }
                    let m = e
                        .metadata()
                        .and_then(|md| md.modified())
                        .unwrap_or(UNIX_EPOCH);
                    if m >= start {
                        found.push((m, p));
                    }
                }
            }
        }
    }
    found.sort_by(|a, b| {
        let name_a = a.1.file_name().and_then(|x| x.to_str()).unwrap_or("");
        let name_b = b.1.file_name().and_then(|x| x.to_str()).unwrap_or("");
        name_a.cmp(name_b).then_with(|| a.0.cmp(&b.0))
    });
    let mut paths = Vec::new();
    for (idx, (_, p)) in found.into_iter().take(want).enumerate() {
        if p.starts_with(&dir) {
            paths.push(p.to_string_lossy().to_string());
        } else {
            // Image came from a CLI's own output dir — copy it into our temp dir so the returned
            // path stays inside the directory the app already serves, leaving the original in place.
            let ext = p
                .extension()
                .and_then(|x| x.to_str())
                .unwrap_or("png")
                .to_lowercase();
            let dest = dir.join(format!("council-{}.{}", idx + 1, ext));
            match std::fs::copy(&p, &dest) {
                Ok(_) => paths.push(dest.to_string_lossy().to_string()),
                Err(_) => paths.push(p.to_string_lossy().to_string()),
            }
        }
    }
    if paths.is_empty() {
        let tail: String = String::from_utf8_lossy(&out.stderr)
            .chars()
            .rev()
            .take(300)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        let _ = std::fs::remove_dir_all(&dir);
        return Err(format!("CLI 没生成出图片文件。{tail}"));
    } else {
        Ok(paths)
    }
}

#[tauri::command]
fn cli_gen_image(program: String, args: Vec<String>, prompt: String) -> Result<String, String> {
    cli_gen_images(program, args, prompt, Some(1)).and_then(|mut urls| {
        urls.pop()
            .ok_or_else(|| "CLI 没生成出图片文件。".to_string())
    })
}

// Save clipboard image bytes (sent from the frontend via navigator.clipboard.read) to a temp
// PNG and return its path, so CLIs that don't read the clipboard themselves (codex / gemini)
// can be handed the file path to reference. claude reads the clipboard natively, so it skips this.
#[tauri::command]
fn save_clip_image(bytes: Vec<u8>) -> Result<String, String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    if bytes.is_empty() {
        return Err("empty image".to_string());
    }
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("council_clip_{}.png", ts));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

// Native macOS folder picker via osascript (no extra dependency / dialog plugin). The
// system dialog itself has a "New Folder" button, so this covers pick + create-in-place.
// Returns None if the user cancels.
#[tauri::command]
fn pick_folder() -> Result<Option<String>, String> {
    let script = r#"set p to ""
try
	set p to POSIX path of (choose folder with prompt "选择项目文件夹")
end try
p"#;
    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| e.to_string())?;
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(if path.is_empty() { None } else { Some(path) })
}

// Pick a parent folder + type a name, then create that folder. Returns the new path
// (None if cancelled). Also via osascript so no dialog-plugin dependency.
#[tauri::command]
fn new_folder() -> Result<Option<String>, String> {
    let script = r#"set p to ""
try
	set parentDir to POSIX path of (choose folder with prompt "新文件夹放在哪个目录下")
	set folderName to text returned of (display dialog "新文件夹名称：" default answer "new-project")
	set p to parentDir & folderName
end try
p"#;
    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| e.to_string())?;
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() {
        return Ok(None);
    }
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(Some(path))
}

// Save a generated image to a user-chosen location. `src` is whatever the frontend holds for the
// image: a local file path (CLI output), a `data:` URL, or an http(s) URL (HTTP provider). The
// browser's `<a download>` is a no-op for cross-origin asset:// / https:// URLs inside the webview,
// so the download flows through here instead. Returns the saved path, or None if cancelled.
#[tauri::command]
async fn export_image(src: String) -> Result<Option<String>, String> {
    let lower = src.to_lowercase();
    let default_name = if lower.contains(".jpg")
        || lower.contains(".jpeg")
        || lower.starts_with("data:image/jpeg")
    {
        "council-image.jpg"
    } else {
        "council-image.png"
    };
    // Pick the destination first (cancel = no-op) so we don't fetch bytes the user won't keep.
    let script = format!(
        "set p to \"\"\ntry\nset p to POSIX path of (choose file name with prompt \"保存图片\" default name \"{default_name}\")\nend try\np"
    );
    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| e.to_string())?;
    let dest = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if dest.is_empty() {
        return Ok(None);
    }
    let bytes = if src.starts_with("data:") || src.starts_with("http://") || src.starts_with("https://") {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|e| e.to_string())?;
        load_image_bytes(&src, &client).await?.0
    } else {
        std::fs::read(&src).map_err(|e| e.to_string())?
    };
    std::fs::write(&dest, bytes).map_err(|e| e.to_string())?;
    Ok(Some(dest))
}

// Download a generated video (an http(s) video_url) to a user-chosen file. Same reason as
// export_image: the webview's `<a download>` / target=_blank is a no-op for cross-origin URLs,
// so the bytes flow through the backend instead. Returns the saved path, or None if cancelled.
#[tauri::command]
async fn export_video(src: String) -> Result<Option<String>, String> {
    let script = "set p to \"\"\ntry\nset p to POSIX path of (choose file name with prompt \"保存视频\" default name \"council-video.mp4\")\nend try\np";
    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| e.to_string())?;
    let dest = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if dest.is_empty() {
        return Ok(None);
    }
    let bytes = if src.starts_with("http://") || src.starts_with("https://") {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(180))
            .build()
            .map_err(|e| e.to_string())?;
        client
            .get(&src)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .bytes()
            .await
            .map_err(|e| e.to_string())?
            .to_vec()
    } else {
        std::fs::read(&src).map_err(|e| e.to_string())?
    };
    std::fs::write(&dest, bytes).map_err(|e| e.to_string())?;
    Ok(Some(dest))
}

// ---- workflow files: saved as ~/.council/workflows/<name>.json ----
fn workflows_dir() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    Path::new(&home).join(".council/workflows")
}

// A workflow name becomes a filename, so reject anything that could escape the dir.
fn safe_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("名字不能为空".to_string());
    }
    if n.contains('/') || n.contains('\\') || n.contains("..") {
        return Err("名字不能包含 / \\ 或 ..".to_string());
    }
    Ok(n.to_string())
}

#[tauri::command]
fn list_workflows() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(workflows_dir()) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) == Some("json") {
                if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                    out.push(stem.to_string());
                }
            }
        }
    }
    out.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    out
}

#[tauri::command]
fn save_workflow(name: String, content: String) -> Result<String, String> {
    let n = safe_name(&name)?;
    let dir = workflows_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{n}.json"));
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn load_workflow(name: String) -> Result<String, String> {
    let n = safe_name(&name)?;
    let path = workflows_dir().join(format!("{n}.json"));
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_workflow(name: String) -> Result<(), String> {
    let n = safe_name(&name)?;
    let path = workflows_dir().join(format!("{n}.json"));
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

// ---- skills: SKILL.md folders under ~/.council/skills/<name>/ ----
fn skills_dir() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    Path::new(&home).join(".council/skills")
}

fn parse_frontmatter(content: &str) -> (Option<String>, Option<String>, Option<String>) {
    let mut name = None;
    let mut desc = None;
    let mut category = None;
    let trimmed = content.trim_start();
    if let Some(rest) = trimmed.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            for line in rest[..end].lines() {
                let line = line.trim();
                if let Some(v) = line.strip_prefix("name:") {
                    name = Some(v.trim().trim_matches(['"', '\'']).to_string());
                } else if let Some(v) = line.strip_prefix("description:") {
                    desc = Some(v.trim().trim_matches(['"', '\'']).to_string());
                } else if let Some(v) = line.strip_prefix("category:") {
                    category = Some(v.trim().trim_matches(['"', '\'']).to_string());
                }
            }
        }
    }
    (name, desc, category)
}

fn skill_display_name(dir: &Path) -> Option<String> {
    let md = dir.join("SKILL.md");
    if !md.is_file() {
        return None;
    }
    let folder = dir.file_name()?.to_string_lossy().to_string();
    let (name, _, _) = std::fs::read_to_string(md)
        .map(|c| parse_frontmatter(&c))
        .unwrap_or((None, None, None));
    Some(name.filter(|s| !s.is_empty()).unwrap_or(folder))
}

fn resolve_skill_dir(name: &str) -> Result<std::path::PathBuf, String> {
    let n = safe_name(name)?;
    let root = skills_dir();
    let exact = root.join(&n);
    if exact.join("SKILL.md").is_file() {
        return Ok(exact);
    }
    if let Ok(entries) = std::fs::read_dir(&root) {
        for e in entries.flatten() {
            let dir = e.path();
            if !dir.is_dir() {
                continue;
            }
            if skill_display_name(&dir).as_deref() == Some(&n) {
                return Ok(dir);
            }
        }
    }
    Err(format!("找不到技能：{n}"))
}

#[derive(Serialize)]
struct SkillInfo {
    name: String,
    description: String,
    category: String,
}

#[tauri::command]
fn list_skills() -> Vec<SkillInfo> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(skills_dir()) {
        for e in entries.flatten() {
            let dir = e.path();
            let Some(name) = skill_display_name(&dir) else {
                continue;
            };
            let (_, d, c) = std::fs::read_to_string(dir.join("SKILL.md"))
                .map(|c| parse_frontmatter(&c))
                .unwrap_or((None, None, None));
            out.push(SkillInfo {
                name,
                description: d.unwrap_or_default(),
                category: c.unwrap_or_default(),
            });
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

#[tauri::command]
fn read_skill(name: String) -> Result<String, String> {
    std::fs::read_to_string(resolve_skill_dir(&name)?.join("SKILL.md")).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_skill(name: String, description: String, category: String, body: String) -> Result<(), String> {
    let n = safe_name(&name)?;
    let dir = skills_dir().join(&n);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Keep frontmatter one-line-safe: collapse newlines in name/description/category.
    let one = |s: &str| s.replace(['\n', '\r'], " ");
    let content = format!(
        "---\nname: {}\ndescription: {}\ncategory: {}\n---\n\n{}\n",
        one(&n),
        one(&description),
        one(&category),
        body
    );
    std::fs::write(dir.join("SKILL.md"), content).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_skill(name: String) -> Result<(), String> {
    std::fs::remove_dir_all(resolve_skill_dir(&name)?).map_err(|e| e.to_string())
}

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

// Find every folder containing a SKILL.md under `root` (a few levels deep).
fn find_skill_dirs(root: &Path, depth: usize, out: &mut Vec<std::path::PathBuf>) {
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        if p.join("SKILL.md").is_file() {
            out.push(p);
        } else {
            find_skill_dirs(&p, depth - 1, out);
        }
    }
}

fn run_git(args: &[&str], cwd: &Path, timeout_secs: u64) -> (bool, String) {
    use std::io::Read;
    // Make git fully non-interactive: a GUI app has no tty, so any credential / SSH
    // host-key / passphrase prompt would otherwise hang forever. Null stdin + these
    // env vars make auth FAIL FAST instead, and a hard timeout is the last backstop.
    let mut child = match std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("PATH", full_path())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "true") // no GUI askpass
        .env("SSH_ASKPASS", "true")
        .env("GCM_INTERACTIVE", "never") // git-credential-manager: never pop a dialog
        .env(
            "GIT_SSH_COMMAND",
            "ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new -oConnectTimeout=10",
        )
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return (false, format!("无法运行 git：{e}（确认已安装 git）")),
    };

    // Drain stdout/stderr on threads so a full pipe buffer can't deadlock the child.
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    if let Some(mut out) = child.stdout.take() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut s = String::new();
            out.read_to_string(&mut s).ok();
            tx.send(s).ok();
        });
    }
    if let Some(mut err) = child.stderr.take() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut s = String::new();
            err.read_to_string(&mut s).ok();
            tx.send(s).ok();
        });
    }
    drop(tx);

    let timeout = std::time::Duration::from_secs(timeout_secs);
    let start = std::time::Instant::now();
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return (
                        false,
                        format!(
                            "git 超时（>{timeout_secs} 秒）已中止。可能原因：① 仓库很大 / 网络慢，\
                             下载没跑完；② 远程认证卡住（私有仓库需 HTTPS 凭证或 SSH key）。\
                             如果只想要某个技能，可在 GitHub 上单独下载它的 SKILL.md，再用「选文件」导入。"
                        ),
                    );
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => return (false, format!("git 等待失败：{e}")),
        }
    };

    let mut combined = String::new();
    while let Ok(s) = rx.recv_timeout(std::time::Duration::from_secs(2)) {
        combined.push_str(&s);
    }
    (success, combined)
}

// Clone a skills repo and copy every SKILL.md folder it contains into the library.
#[tauri::command]
fn skills_download(url: String, on_event: Channel<StreamEvent>) {
    std::thread::spawn(move || {
        let tmp = std::env::temp_dir().join("council-skill-clone");
        let _ = std::fs::remove_dir_all(&tmp);
        on_event.send(StreamEvent::Delta { text: format!("clone {url}\n") }).ok();
        let (ok, out) = run_git(
            &["clone", "--depth", "1", "--single-branch", "--no-tags", &url, tmp.to_string_lossy().as_ref()],
            &std::env::temp_dir(),
            300, // big skill repos (lots of example images) can take minutes
        );
        let _ = on_event.send(StreamEvent::Delta { text: out });
        if !ok {
            let _ = on_event.send(StreamEvent::Error { message: "克隆失败".to_string() });
            let _ = std::fs::remove_dir_all(&tmp);
            return;
        }
        let mut found = Vec::new();
        find_skill_dirs(&tmp, 4, &mut found);
        if found.is_empty() {
            let _ = on_event.send(StreamEvent::Error {
                message: "仓库里没找到任何含 SKILL.md 的文件夹".to_string(),
            });
            let _ = std::fs::remove_dir_all(&tmp);
            return;
        }
        let lib = skills_dir();
        let _ = std::fs::create_dir_all(&lib);
        let mut names = Vec::new();
        for src in &found {
            let folder = src.file_name().unwrap().to_string_lossy().to_string();
            if copy_dir_all(src, &lib.join(&folder)).is_ok() {
                names.push(folder);
            }
        }
        let _ = std::fs::remove_dir_all(&tmp);
        let _ = on_event.send(StreamEvent::Delta {
            text: format!("\n导入 {} 个技能：{}\n", names.len(), names.join("、")),
        });
        let _ = on_event.send(StreamEvent::Done);
    });
}

// Commit the whole skill library and push it to `url` using the user's git credentials.
#[tauri::command]
fn skills_upload(url: String, message: String, on_event: Channel<StreamEvent>) {
    std::thread::spawn(move || {
        let dir = skills_dir();
        if std::fs::create_dir_all(&dir).is_err() {
            let _ = on_event.send(StreamEvent::Error { message: "无法创建技能库目录".to_string() });
            return;
        }
        let msg = if message.trim().is_empty() { "update skills" } else { message.trim() };
        // Push to remote `main` via HEAD:main so it works whether the local default
        // branch is master or main, and without needing a commit before renaming.
        let steps: Vec<Vec<&str>> = vec![
            vec!["init"],
            vec!["add", "-A"],
            vec!["commit", "-m", msg],
            vec!["remote", "remove", "origin"],
            vec!["remote", "add", "origin", &url],
            vec!["push", "-u", "origin", "HEAD:main"],
        ];
        for args in &steps {
            let (ok, out) = run_git(args, &dir, 120);
            if !out.trim().is_empty() {
                let _ = on_event.send(StreamEvent::Delta { text: format!("$ git {}\n{}\n", args.join(" "), out) });
            }
            if ok {
                continue;
            }
            // "remote remove" fails harmlessly when there's no origin yet; "commit"
            // fails harmlessly only when there's nothing to commit. Anything else
            // (e.g. git identity not set, push rejected) is a real error.
            let tolerant = matches!(args.as_slice(), ["remote", "remove", ..])
                || (matches!(args.as_slice(), ["commit", ..])
                    && (out.contains("nothing to commit") || out.contains("working tree clean")));
            if !tolerant {
                let _ = on_event.send(StreamEvent::Error {
                    message: format!("git {} 失败", args.join(" ")),
                });
                return;
            }
        }
        let _ = on_event.send(StreamEvent::Done);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Ptys::default())
        .invoke_handler(tauri::generate_handler![
            chat_stream,
            cli_run,
            spawn_pty,
            write_pty,
            resize_pty,
            close_pty,
            dir_exists,
            read_text_file,
            append_team_notes,
            code_snapshot,
            write_project_file,
            cli_gen_images,
            cli_gen_image,
            save_clip_image,
            pick_folder,
            new_folder,
            export_image,
            export_video,
            fetch_url,
            image_generate,
            video_generate,
            list_workflows,
            save_workflow,
            load_workflow,
            delete_workflow,
            list_skills,
            read_skill,
            save_skill,
            delete_skill,
            skills_download,
            skills_upload
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ---- unit tests (补测试 responsibility) ----
// These cover the pure / deterministic helpers that power the Tauri commands.
// Run with: cargo test (from src-tauri/)
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_name_rejects_bad_chars() {
        assert!(safe_name("").is_err());
        assert!(safe_name("a/b").is_err());
        assert!(safe_name("..").is_err());
        assert!(safe_name("ok-name_123").is_ok());
    }

    #[test]
    fn parse_frontmatter_extracts_fields() {
        let md = r#"---
name: my-skill
description: "Does the thing"
category: writing
---
body here
"#;
        let (n, d, c) = parse_frontmatter(md);
        assert_eq!(n.as_deref(), Some("my-skill"));
        assert_eq!(d.as_deref(), Some("Does the thing"));
        assert_eq!(c.as_deref(), Some("writing"));
    }

    #[test]
    fn parse_frontmatter_handles_no_frontmatter() {
        let (n, d, c) = parse_frontmatter("just body");
        assert!(n.is_none() && d.is_none() && c.is_none());
    }

    #[test]
    fn html_to_text_strips_scripts_and_tags() {
        let html = r#"<html><head><title>t</title></head><body><script>bad()</script><p>Hello <b>world</b> &amp; <i>you</i></p></body></html>"#;
        let out = html_to_text(html);
        assert!(out.contains("Hello"));
        assert!(out.contains("world"));
        assert!(!out.contains("bad()"));
        assert!(!out.contains("<"));
    }

    #[test]
    fn html_to_text_caps_huge_input() {
        let big = "x".repeat(600_000);
        let out = html_to_text(&big);
        assert!(out.len() < 500_100);
    }

    #[test]
    fn expand_home_path_variants() {
        let home = std::env::var("HOME").unwrap_or_default();
        assert_eq!(expand_home_path("~"), home);
        if !home.is_empty() {
            let p = expand_home_path("~/foo/bar");
            assert!(p.starts_with(&home));
            assert!(p.ends_with("foo/bar"));
        }
        assert_eq!(expand_home_path("/abs/path"), "/abs/path");
    }
}
