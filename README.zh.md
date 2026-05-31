<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="96" height="96" alt="council logo" />

# council

**轻量多模型工作流桌面应用。**
把不同的大模型串成一条流水线，每一步交给一个模型干一件事，上一步的产出喂给下一步。

简体中文 · [English](./README.md)

Tauri 2 · vanilla TypeScript · 无前端框架

</div>

---

## 这是什么

`council` 让你把多个模型接成一条线性**流水线**。每一步各选自己的模型（在线 API，或本地 CLI
如 Claude Code / Codex），只干一件事——起草、修改、核查、润色——再把产出喂给下一步。另有一个
一次成稿的**单篇（GEO）**模式，一遍生成完整文章 + 配套小推文，可选内联配图。

整个应用作为原生桌面程序在本地运行。**API Key 只存在本机浏览器的 localStorage**，除了你自己
配置的厂商接口，绝不外发。

## 功能

- **文本流水线** —— 多步骤，每步各选模型和指令。指令里用占位符引用上游产出：
  `{{input}}`（初始输入）、`{{prev}}`（上一步）、`{{1}}` `{{2}}` …（第 N 步）。
- **模型市场** —— 内置 DeepSeek / OpenAI / Gemini / 千问 / Kimi / GLM / xAI Grok / Mistral /
  火山豆包 / Ollama / MiniMax 预设。任何兼容 OpenAI `/chat/completions` 的厂商，加一个即可用。
- **本地 CLI 工作器** —— 通过通用 `cli_run`（程序 + 参数 + prompt）把本地 agent
  （Claude Code、Codex、Gemini CLI、Grok CLI）当作流水线的一步来跑。
- **技能库** —— `~/.council/skills` 下可复用的 `SKILL.md` 提示词，可按步骤挂载。支持从本地
  文件/文件夹导入，或与 git 仓库同步（下载 / 上传）。
- **单篇（GEO）模式** —— 独立的成稿生成器：标题/主题、可选路线/地点、10 种文风、篇幅滑块，
  可贴原文素材或填参考链接，可选内联配图。输出可编辑的正文 + 小推文，可复制或导出 Markdown。
- **文生图** —— 走 OpenAI-images 风格接口（如火山 Seedream），或用本地 CLI 出 SVG。
- **文生视频** —— 异步文生视频（火山方舟 / Seedance），结果卡片里直接渲染播放。
- **命名工作流** —— 整条流水线可存为文件，随时加载 / 删除。

## 跑起来

依赖：[Node.js](https://nodejs.org/) 18+、[Rust](https://rustup.rs/)（stable），以及对应系统的
[Tauri 2 环境](https://tauri.app/start/prerequisites/)。

```sh
npm install
npm run tauri dev      # 开发模式，开窗口（带 HMR）
npm run tauri build    # 打包 release .app / .dmg（或对应平台产物）
```

## 用法

1. 右上角「**厂商 / 命令 / Key**」里填 API Key。默认有一条 DeepSeek，填上 key 即可。其他兼容
   OpenAI 接口格式的厂商（Kimi、千问百炼、火山方舟、OpenAI 等），点击加一个厂商，Endpoint
   填到 `/chat/completions` 为止。
2. 左侧编辑流水线：每一步选一个模型（或本地 Claude CLI），写指令。
3. 指令里可用占位符引用上游内容：
   - `{{input}}` —— 顶部的初始输入
   - `{{prev}}` —— 上一步的输出
   - `{{1}}` `{{2}}` … —— 第 N 步的输出
4. 点「**▶ 运行**」，从上到下逐步执行，结果在右侧流式显示。
5. 顶栏切到「**单篇**」即进入一次成稿的 GEO 生成器。

## 架构

Rust 后端（`src-tauri/src/lib.rs`）暴露少量 Tauri 命令；vanilla-TS 前端负责编排流水线并流式渲染。

| 命令 | 作用 |
| --- | --- |
| `chat_stream` | 兼容 OpenAI 的 `/chat/completions`（SSE），增量通过 Tauri Channel 流给前端 |
| `cli_run` | 跑本地 CLI 工作器（程序 + 固定参数 + prompt 作为最后一个 argv） |
| `fetch_url` | 抓网页并提取正文（供参考链接喂料） |
| `image_generate` | 文生图（OpenAI-images 风格，返回图片 URL） |
| `video_generate` | 异步文生视频任务（提交 + 轮询），返回视频 URL |
| `*_workflow` / `*_skill` | 工作流和技能的存 / 读 / 列 / 删；技能的 git 下载 / 上传 |

- **流式**：HTTP 和 CLI 工作器都通过 Tauri `Channel<StreamEvent>` 把增量文本推给前端，前端统一处理。
- **`reqwest`** 用 `rustls-tls`，不依赖系统 OpenSSL。
- **Key** 只存 localStorage。点「停止」只停前端监听；后端已发出的 HTTP 请求会在后台跑完。

## 待办

- 单篇模式的多模型协作写作（writer→editor 链 / 各出一版对比）。
- 圆桌讨论模式（同一问题，多模型、多轮讨论 + 汇总）。

## 许可

[MIT](./LICENSE)
