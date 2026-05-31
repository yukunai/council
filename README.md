<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="96" height="96" alt="council logo" />

# council

**A lightweight multi-model workflow desktop app.**
Chain different LLMs into a pipeline where each step does one job — the output of one step feeds the next.

[简体中文](./README.zh.md) · English

Tauri 2 · vanilla TypeScript · no frontend framework

</div>

---

## What it is

`council` lets you wire several models into a linear **pipeline**. Each step picks its own
model (a hosted API, or a local CLI like Claude Code / Codex) and does one thing — draft, revise,
fact-check, polish — passing its output downstream. There's also a one-shot **single-article**
mode (GEO) for generating a finished article + social post in a single pass, with optional
inline image generation.

Everything runs locally as a native desktop app. **API keys live only in your browser's
localStorage** — they are never sent anywhere except the provider endpoint you configure.

## Features

- **Text pipeline** — multiple steps, each with its own model and instruction. Reference upstream
  output with placeholders: `{{input}}` (initial input), `{{prev}}` (previous step), `{{1}}` `{{2}}` … (step N).
- **Model market** — presets for DeepSeek, OpenAI, Gemini, Qwen, Kimi, GLM, xAI Grok, Mistral,
  Volcengine Doubao, Ollama, MiniMax. Any OpenAI-compatible `/chat/completions` endpoint works by
  adding a provider.
- **Local CLI workers** — drive local agents (Claude Code, Codex, Gemini CLI, Grok CLI) as pipeline
  steps via a generic `cli_run` (program + args + prompt).
- **Skills library** — reusable `SKILL.md` prompts in `~/.council/skills`, attachable per step.
  Import from local files/folders, or sync with a git repo (download / upload).
- **Single-article (GEO) mode** — a standalone generator: title/topic, optional route/places,
  10 writing styles, length slider, feed it raw material or a reference URL, optional inline
  images. Outputs an editable article + a short social post; copy or export to Markdown.
- **Image generation** — text-to-image via OpenAI-images-style endpoints (e.g. Volcengine Seedream),
  or SVG via a local CLI worker.
- **Video generation** — async text-to-video (Volcengine Ark / Seedance), rendered in the result card.
- **Named workflows** — save / load / delete whole pipelines as files.

## Run it

Requirements: [Node.js](https://nodejs.org/) 18+, [Rust](https://rustup.rs/) (stable), and the
[Tauri 2 prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```sh
npm install
npm run tauri dev      # development mode, opens a window with HMR
npm run tauri build    # build a release .app / .dmg (or platform equivalent)
```

## Usage

1. Open **厂商 / 命令 / Key** (Providers / Commands / Keys) in the top bar and paste your API key.
   A DeepSeek provider is seeded — just add the key. For any other OpenAI-compatible service,
   click to add a provider and set its Endpoint up to and including `/chat/completions`.
2. In the left panel, build the pipeline: each step picks a model (or a local CLI) and an instruction.
3. Use placeholders in instructions to reference upstream output:
   - `{{input}}` — the initial input at the top
   - `{{prev}}` — the previous step's output
   - `{{1}}` `{{2}}` … — the output of step N
4. Click **▶ 运行 (Run)**. Steps execute top to bottom and stream into the right-hand results panel.
5. Switch to **单篇 (Single-article)** in the top bar for the one-shot GEO generator.

## Architecture

The Rust backend (`src-tauri/src/lib.rs`) exposes a handful of Tauri commands; the vanilla-TS
frontend orchestrates the pipeline and streams each step.

| Command | Purpose |
| --- | --- |
| `chat_stream` | OpenAI-compatible `/chat/completions` (SSE), streams deltas over a Tauri Channel |
| `cli_run` | runs a local CLI worker (program + fixed args + prompt as final argv) |
| `fetch_url` | fetches a web page and extracts readable text (for reference-URL feeding) |
| `image_generate` | text-to-image (OpenAI-images-style, returns an image URL) |
| `video_generate` | async text-to-video task API (submit + poll), returns a video URL |
| `*_workflow` / `*_skill` | save / load / list / delete workflows and skills; git download / upload of skills |

- **Streaming**: both HTTP and CLI workers push incremental text to the frontend over a Tauri
  `Channel<StreamEvent>`; the frontend handles them uniformly.
- **`reqwest`** uses `rustls-tls` (no system OpenSSL dependency).
- **Keys** are stored only in localStorage. Stopping a run stops the frontend from listening; an
  in-flight backend HTTP request finishes in the background.

## Roadmap

- Multi-model co-writing for the single-article mode (writer→editor chain / parallel variants to compare).
- Round-table discussion mode (same question, multiple models, multiple rounds + summary).

## License

[MIT](./LICENSE)
