<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="96" height="96" alt="Council logo" />

# Council

**一个轻量的桌面多模型 AI 工作台。**
把模型串成流水线、让多个模型同台辩论、编排本地编程 Agent，或者就是单纯聊天 —— 一个原生应用，用你自己的 Key，不依赖任何前端框架。

[English](./README.md) · 简体中文 · [Español](./README.es.md) · [Português](./README.pt.md) · [Français](./README.fr.md) · [Deutsch](./README.de.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md) · [Tiếng Việt](./README.vi.md) · [Bahasa Indonesia](./README.id.md) · [हिन्दी](./README.hi.md) · [ไทย](./README.th.md) · [Türkçe](./README.tr.md) · [العربية](./README.ar.md)

Tauri 2 · 原生 TypeScript · 无前端框架 · macOS / Windows / Linux

</div>

---

## 它是什么

Council 把**许多 AI 模型 —— 既有在线 API、也有本地 CLI Agent —— 装进同一个窗口**。你不用再在一堆浏览器标签和终端之间来回切，而是把它们组合起来：把一个模型的输出喂给下一个，让多个模型回答同一个问题再汇总，或者把一个项目文件夹交给一队编程 Agent。

它**本地优先、不绑厂商**。任何 OpenAI 兼容的 `/chat/completions` 端点都能用，还能并排驱动本地 Agent CLI（Claude Code、Codex、Gemini CLI、Grok、Cursor Agent）。**API Key 只存在应用本地存储里** —— 除了你自己配置的厂商端点，不会发往任何其它地方。

## 六种模式

顶栏切换模式；每种模式左边是编辑区，右边是流式结果 / 对话区。

### 🔗 工作流（流水线）
把多个步骤串成线性流水线。每一步选自己的模型（API 或本地 CLI）+ 一条指令 —— 起草、修改、核查、翻译、润色 —— 把输出往下传。用占位符引用上游结果：
- `{{input}}` —— 顶部的初始输入
- `{{prev}}` —— 上一步的输出
- `{{1}}` `{{2}}` … —— 第 N 步的输出

步骤按**依赖关系并行**：纯链式自动串行；只引用 `{{input}}` 的步骤会扇出同时跑。整条流水线可作为**命名工作流**保存 / 载入 / 删除。

### 📰 GEO（单篇成文）
一次成文的生成器：标题/主题、可选路线/地点，10 种写作风格、长度滑块，喂素材或一个参考链接（应用会抓取并提取正文）。可选**文章内自动配图**。产出可编辑的文章 + 一条社媒短文，复制或导出 Markdown。

### 🗣️ 圆桌
对**多个模型、多轮**抛出同一个问题。第一位起草，后面每位在上一位答案上改进，最后由主持人模型综述「共识 / 分歧 / 最终建议」。每张参与者卡片都能直接改，还能**针对任意单个模型一对一追问**（包括主持人）—— 它的回复成为新卡片可继续追问。整场对话连同每张卡片都存进历史。

### 🛠️ 任务编排（协作编程）
把一队 Agent 指向一个项目文件夹和一个任务。每个 **CLI Agent**（Claude Code、Codex、Gemini、Grok、Cursor）各开一个实时终端、并排改真实文件，通过共享的 `TEAM_NOTES.md` 协作（审查方留反馈，实现方读取后改）。「持续协作」循环让它们不断对彼此的改动作出反应；工具栏可单独或一键全部停止/开启。

**API 模型也能加入** —— 在线模型（DeepSeek、千问、GLM…）无需终端即可参与：它读 `TEAM_NOTES.md` + 项目代码快照，然后要么**把整文件写回**（主写），要么**把审查反馈追加进** `TEAM_NOTES.md`（审查）。文件写入限制在项目目录内。

### 💬 聊天
客户端式的单模型一对一聊天（API 或 CLI），模型选择和输入框停靠在底部。多轮 —— 每轮把之前的对话作为上下文一起发送。左侧技能库勾选的技能会叠加进系统提示。推理模型（如 QwQ）会在答案上方的可折叠框里流式显示**思考过程**。左侧**聊天历史侧栏**保存每段过往对话，可搜索、可继续。

### ▶️ 终端
内嵌的交互式终端（PTY）—— 最多分屏三栏、带标签页。启动任意 shell 或 Agent CLI，可粘贴图片、运行时发送技能。任务编排的 Agent 也跑在这里。

另外还有一个应用内**浏览器**窗口，方便查资料不用离开应用。

## 模型与技能

- **模型库** —— DeepSeek、OpenAI、Gemini、千问（阿里百炼）、Kimi（月之暗面）、GLM（智谱）、xAI Grok、Mistral、火山豆包、Ollama（本地）、MiniMax 一键预设。任何 OpenAI 兼容端点都能自行添加厂商接入。
- **本地 CLI Worker** —— 凡是能选模型的地方都能选本地 Agent CLI，底层走通用的 `cli_run`（程序 + 参数 + 提示词）。
- **思考过程展示** —— 单独流式输出 `reasoning_content` 的模型（QwQ、DeepSeek-R1…）会在答案前用可折叠灰框显示思考过程。
- **技能库** —— `~/.council/skills` 下可复用的 `SKILL.md` 提示词，可按步骤/Agent/聊天挂载。支持从本地文件或文件夹导入、分类整理，或与 git 仓库同步（下载 / 上传）。
- **视频生成** —— 异步文生视频（火山方舟 / Seedance），在结果卡片里播放。
- **14 种语言** —— 完整 UI 本地化（English、简体中文、Español、Português、Français、Deutsch、日本語、한국어、Tiếng Việt、Bahasa Indonesia、हिन्दी、ไทย、Türkçe、العربية）。

## 运行

环境要求：[Node.js](https://nodejs.org/) 18+、[Rust](https://rustup.rs/)（stable），以及对应系统的 [Tauri 2 依赖](https://tauri.app/start/prerequisites/)。

```sh
npm install
npm run tauri dev      # 开发模式，开窗口 + 热更新
npm run tauri build    # 构建发布版 .app / .dmg（或对应平台产物）
npm run test           # 跑单元测试（vitest）
```

每个 [GitHub Release](../../releases) 都挂了 macOS（Apple Silicon）的 `.dmg` / `.zip`。应用未签名 —— 首次打开请右键 →「打开」。

## 快速上手

1. 顶栏打开 **接入（厂商 / Key）**，粘贴 API Key。已内置 DeepSeek 厂商，填上 Key 即可；其它 OpenAI 兼容服务点添加厂商，端点填到并包含 `/chat/completions`（**模型库**里有一键预设）。
2. 顶栏选一种模式开始搭：
   - **工作流** —— 加步骤，每步选模型 + 指令，用占位符串联。
   - **圆桌** —— 输入问题，加 2 个以上参与模型，选主持人和轮数。
   - **任务编排** —— 选项目文件夹 + 任务，加 CLI 和/或 API Agent。
   - **聊天** —— 选模型直接开聊。
3. 点 **▶ 运行**（聊天里是**发送**），结果流式输出到右侧。

## 架构

Rust 后端（`src-tauri/src/lib.rs`）暴露一组 Tauri 命令；原生 TS 前端（`src/main.ts`）编排所有模式并流式渲染。无前端框架 —— 纯 DOM + 一个小 `i18n` 层。

| 模块 | 命令 |
| --- | --- |
| 聊天 / 模型 | `chat_stream`（OpenAI 兼容 SSE，把 `delta` + `reasoning_content` + 用量经 Tauri Channel 流式推送） |
| 本地 CLI | `cli_run`（单轮 Worker）、`cli_gen_image(s)`（Agent 生成图片文件） |
| 终端 | `spawn_pty` / `write_pty` / `resize_pty` / `close_pty`（基于 `portable-pty` 的交互式 PTY） |
| 任务编排文件 | `read_text_file`、`append_team_notes`、`code_snapshot`、`write_project_file`（写入限制在项目目录内） |
| 浏览器 | `browser_navigate` / `reload` / `history` / `url` / `open_external`（仅 http(s)；外部打开不经过 shell） |
| 媒体 | `image_generate`（文生图 + 图生图）、`video_generate`（异步提交 + 轮询）、`export_image` / `export_video` |
| 文件 / 同步 | `fetch_url`、`pick_folder`、`new_folder`、`dir_exists`、`*_workflow`、`*_skill`、`skills_download` / `skills_upload` |

- **流式** —— HTTP 和 CLI Worker 都把增量文本经 Tauri `Channel<StreamEvent>` 推给前端，统一处理。
- **`reqwest`** 用 `rustls-tls`（不依赖系统 OpenSSL）。
- **Key 与数据**存在应用本地存储里，对话、工作流、历史也持久化在那；技能是 `~/.council/skills` 下的纯 `SKILL.md` 文件。

## 许可

[MIT](./LICENSE)
