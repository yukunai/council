<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="96" height="96" alt="Council logo" />

# Council

**A lightweight, multi-model AI workspace for your desktop.**
Chain models into pipelines, let several debate a question, orchestrate local coding agents, or just chat — one native app, your keys, no framework.

[简体中文](./README.zh.md) · English · [Español](./README.es.md) · [Português](./README.pt.md) · [Français](./README.fr.md) · [Deutsch](./README.de.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md) · [Tiếng Việt](./README.vi.md) · [Bahasa Indonesia](./README.id.md) · [हिन्दी](./README.hi.md) · [ไทย](./README.th.md) · [Türkçe](./README.tr.md) · [العربية](./README.ar.md)

Tauri 2 · vanilla TypeScript · no frontend framework · macOS / Windows / Linux

</div>

---

## What it is

Council is a single desktop app that puts **many AI models — both hosted APIs and local CLI agents — behind one window**. Instead of juggling browser tabs and terminals, you compose them: feed one model's output into the next, have several answer the same question and reconcile, or hand a folder to a team of coding agents.

It is **local-first and provider-agnostic**. Any OpenAI-compatible `/chat/completions` endpoint works, alongside local agent CLIs (Claude Code, Codex, Gemini CLI, Grok, Cursor Agent). **Your API keys live only in the app's local storage** — they are sent to nothing except the provider endpoint you configure.

## The six modes

Switch modes from the top bar; each has its own editor on the left and a streaming result/conversation area on the right.

### 🔗 Workflow (pipeline)
Wire several steps into a linear pipeline. Each step picks its own model (API or local CLI) and a single instruction — draft, revise, fact-check, translate, polish — and passes its output downstream. Reference upstream output with placeholders:
- `{{input}}` — the initial input at the top
- `{{prev}}` — the previous step's output
- `{{1}}` `{{2}}` … — the output of step N

Steps run with **dependency-aware parallelism**: a pure chain stays serial, but steps that only read `{{input}}` fan out and run at once. Save / load / delete whole pipelines as **named workflows**.

### 📰 GEO (single article)
A one-shot generator for a finished article + short social post in a single pass. Give it a title/topic, optional route/places, pick from 10 writing styles, set a length, and feed it raw material or a reference URL (the app fetches and extracts the page text). Optional **inline image generation** drops illustrations into the article. Output is editable; copy or export to Markdown.

### 🗣️ Round-table
Pose one question to **several models across multiple rounds**. The first drafts an answer, each subsequent model improves on the previous one, and a moderator model synthesizes a final **Consensus / Disagreements / Recommendation** summary. Every participant card is editable, and you can **follow up one-on-one with any single model** (including the moderator) — its reply becomes a new card you can keep questioning. Conversations are saved to history with each card preserved.

### 🛠️ Orchestration (collaborative coding)
Point a team of agents at a project folder and a task. Each **CLI agent** (Claude Code, Codex, Gemini, Grok, Cursor) gets its own live terminal, side by side, editing real files. They coordinate through a shared `TEAM_NOTES.md` (reviewers leave feedback the implementer reads). A "continuous collaboration" loop keeps them reacting to each other's changes; stop/start any one or all from the toolbar.

**API models can join too** — a hosted model (DeepSeek, Qwen, GLM…) participates without a terminal: it reads `TEAM_NOTES.md` plus a snapshot of the project, then either **writes whole files back** (implementer) or **appends review feedback** to `TEAM_NOTES.md` (reviewer). File writes are confined to the project directory.

### 💬 Chat
A clean, client-style one-on-one chat with a single model (API or CLI), with the model picker and input docked at the bottom. Multi-turn — the prior conversation is sent as context each turn. Skills checked in the left library layer onto the system prompt. Reasoning models (e.g. QwQ) stream their **chain-of-thought** in a collapsible box above the answer. A **chat-history sidebar** keeps every past conversation, searchable and resumable.

### ▶️ Terminal
Embedded interactive terminals (PTY) — split into up to three panes with tabs. Launch any shell or agent CLI, paste images, send skills at runtime. This is also where Orchestration agents live.

Plus an in-app **browser** window for quick reference without leaving the app.

## Models & skills

- **Model market** — one-click presets for DeepSeek, OpenAI, Gemini, Qwen (Alibaba Bailian), Kimi (Moonshot), GLM (Zhipu), xAI Grok, Mistral, Volcengine Doubao, Ollama (local), MiniMax. Any OpenAI-compatible endpoint works by adding a provider.
- **Local CLI workers** — drive agent CLIs as workers anywhere a model is selectable, via a generic `cli_run` (program + args + prompt).
- **Reasoning display** — models that stream a separate `reasoning_content` (QwQ, DeepSeek-R1, …) show their thinking in a collapsible gray box, ahead of the answer.
- **Skills library** — reusable `SKILL.md` prompts in `~/.council/skills`, attachable per step/agent/chat. Import from local files or folders, organize into categories, or sync with a git repo (download / upload).
- **Video generation** — async text-to-video (Volcengine Ark / Seedance), rendered in the result card.
- **14 languages** — full UI localization (English, 简体中文, Español, Português, Français, Deutsch, 日本語, 한국어, Tiếng Việt, Bahasa Indonesia, हिन्दी, ไทย, Türkçe, العربية).

## Run it

Requirements: [Node.js](https://nodejs.org/) 18+, [Rust](https://rustup.rs/) (stable), and the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```sh
npm install
npm run tauri dev      # development mode, opens a window with HMR
npm run tauri build    # build a release .app / .dmg (or platform equivalent)
npm run test           # run the unit test suite (vitest)
```

Prebuilt macOS (Apple Silicon) `.dmg` / `.zip` are attached to each [GitHub Release](../../releases). The app is unsigned — on first launch, right-click → Open.

## Quick start

1. Open **接入 (Providers / Keys)** in the top bar and paste an API key. A DeepSeek provider is seeded — just add the key. For any other OpenAI-compatible service, add a provider and set its Endpoint up to and including `/chat/completions` (the **模型库 / Model market** has one-click presets).
2. Pick a mode in the top bar and build it:
   - **Workflow** — add steps, choose a model + instruction per step, wire them with placeholders.
   - **Round-table** — type a question, add 2+ participants, pick a moderator and round count.
   - **Orchestration** — pick a project folder + task, add CLI and/or API agents.
   - **Chat** — pick a model and start typing.
3. Click **▶ Run** (or **Send** in Chat). Output streams into the right-hand panel.

## Architecture

The Rust backend (`src-tauri/src/lib.rs`) exposes a set of Tauri commands; the vanilla-TS frontend (`src/main.ts`) orchestrates every mode and streams results. No frontend framework — DOM + a small `i18n` layer.

| Area | Commands |
| --- | --- |
| Chat / models | `chat_stream` (OpenAI-compatible SSE, streams `delta` + `reasoning_content` + usage over a Tauri Channel) |
| Local CLI | `cli_run` (one-shot worker), `cli_gen_image(s)` (agent-generated image files) |
| Terminals | `spawn_pty` / `write_pty` / `resize_pty` / `close_pty` (interactive PTY via `portable-pty`) |
| Orchestration files | `read_text_file`, `append_team_notes`, `code_snapshot`, `write_project_file` (writes confined to the project dir) |
| Browser | `browser_navigate` / `reload` / `history` / `url` / `open_external` (http(s) only; external opens never route through a shell) |
| Media | `image_generate` (text-to-image + img2img), `video_generate` (async submit + poll), `export_image` / `export_video` |
| Files / sync | `fetch_url`, `pick_folder`, `new_folder`, `dir_exists`, `*_workflow`, `*_skill`, `skills_download` / `skills_upload` |

- **Streaming** — HTTP and CLI workers both push incremental text to the frontend over a Tauri `Channel<StreamEvent>`, handled uniformly.
- **`reqwest`** uses `rustls-tls` (no system OpenSSL dependency).
- **Keys & data** live in the app's local storage; conversations, workflows, and history persist there too. Skills are plain `SKILL.md` files under `~/.council/skills`.

## License

[MIT](./LICENSE)
