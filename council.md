# council 开发笔记 / 变更记录

> 项目的功能演进与关键决策记录（按时间倒序，最新在上）。

## 2026-06-01

### 发布 v0.1.0 安装包
- 源码已 commit 并 push 到 `origin/main`（`1b910ab`）。
- GitHub Release **v0.1.0**：挂了两个 macOS Apple Silicon (arm64) 安装包——`council_0.1.0_aarch64.dmg`（拖入应用程序）和 `council_0.1.0_macos_arm64.zip`（解压即用）。本地未签名，首次右键「打开」。
- 打包命令：`npm run tauri build`；dmg 偶发失败是上次残留的临时 rw 镜像还挂着，先 `hdiutil detach` 卸掉再 build 即可。

### 技能分类的最终形态
- 分类**只用于技能库整理/筛选，不绑定到协作编程 Agent**（曾实现"分类绑定 Agent / 按分类过滤 chips"，但与设计冲突，已撤回——Agent 仍只看勾选的具体技能 + 默认技能）。
- 归类入口：技能库大窗每张卡片底部的「分类」下拉（主路径，稳）；拖拽为辅（HTML5 DnD 用模块变量传被拖项，不靠 WKWebView 不可靠的 dataTransfer）。
- 左侧技能栏顶部有**分类筛选 chip**（全部/各分类/未分类，动态）；勾选框 = 默认技能（不是删除，删除在「仓库」）。

### 圆桌/流水线：codex / gemini 调不动的根因 + 修复
- 这俩 CLI 在 **headless（圆桌/流水线走 `cli_run` 管道、无 tty、在 app 工作目录）+ 非信任目录** 下会拒绝运行：codex 报 `Not inside a trusted directory … --skip-git-repo-check`，gemini 报 `not running in a trusted directory … --skip-trust`。
- 修复：预设参数改为 codex `exec --skip-git-repo-check`、gemini `-p --skip-trust`；并加一次性迁移自动给已配的补上。claude/grok 无此要求。
- 只影响圆桌/流水线（headless）；协作编程/终端走交互 PTY，不受影响。

### 协作编程：claude 启动卡在 bypass 确认 → 自动接受
- `claude --dangerously-skip-permissions` 交互启动时弹一次性 "Bypass Permissions … ❯1. No / 2. Yes, I accept" 菜单，默认在「No」，不选就一直等（看着像启动不了）。
- 修复：**监听 PTY 输出**，检测到菜单标志词（`confirm` + `exit`，因为 "Yes, I accept" 被光标转义码拆开匹配不到）后，自动发「↓」再「回车」选中「2. Yes」。靠"菜单已渲染"驱动、不是盲发定时（盲发会落在默认 No 上把它选退出）。只在「自动批准」勾选时生效。

## 2026-05-31

### 技能库支持拖拽分类（最新）
- 在技能库大窗（⛶ 全部）里，**拖技能卡片到左侧分类**即可把它归入该分类（底层重存 SKILL.md 的 `category`，保留描述/正文）。
- 拖到「未分类」= 清掉分类；「全部」不是落点。拖动时分类项虚线高亮提示。
- 解决"新建分类后无法把已有技能拖进去"——之前只能进技能编辑改分类字段。

### 终端调用技能：去掉启动器 chips，改为运行时 ⚡技能
- **终端启动器去掉「技能」那一排 chips**——启动器只剩 目录 / 参数 / ▶（终端·Claude·Codex·Grok）。
- 技能在终端里**统一走运行时**：每个分屏标签条上的「⚡技能」按钮，弹出可搜索的技能列表，点一个就把它的正文（折成一行 + 回车）`write_pty` 发给当前 CLI——**对话中随时可发**，不用退出重进（解决"只能启动时选"的痛点）。
- **默认技能**（左栏勾选 = `defaultSkills`）现在**只作用于协作编程**（每个 Agent 有效技能 = 自己的 ∪ 默认，自动注入系统提示）；终端不吃默认技能，按需用 ⚡技能 即可。

### 技能系统
- 左栏技能列表重做成 Claude Code 风：勾选框 + 技能名 + 下方两行描述 + ✎ 改名；删除统一在「仓库」大窗的卡片上（左栏不放删除，防误删）。
- 协作编程每个 Agent 可挂**多个技能**（chips 多选，`CodeAgent.skills[]`）。
- 技能库大窗（⛶ 全部）可**新建分类**：分类栏顶部输入框新建（允许空分类），编辑技能时「分类」字段带 datalist 可选已有 / 输入新分类。

### 关键 bug 根因 + 修复
- **全局 CSS `input { width: 100% }` 把 checkbox 也撑成满行宽**，导致同行的技能名/描述被挤成右侧看不见的窄缝（「自动批准」复选框旁文字不显示也是同因）。
- 修复：该规则选择器改为 `input:not([type="checkbox"]):not([type="radio"])`，复选框恢复原生小方块。
- 教训：加 checkbox 前先确认全局 `input` 规则不会套到它。

### 协作编程：重构为交互终端
- 点运行 → 切到终端，每个 Agent **各开一个交互式 PTY 终端并排**，实时看输出、可随时打字追问。
- Agent 之间靠项目根的 `TEAM_NOTES.md` 共享反馈（审查/测试把问题写进去，实现的读它来改）。
- 各 CLI 启动语法不同（`CLI_LAUNCH`）：claude 位置参数 + `--dangerously-skip-permissions`；codex 位置参数 + `--dangerously-bypass-approvals-and-sandbox`；gemini 位置参数 + `--yolo`；grok **不收位置参数提示词**（经 stdin 喂入）+ `--always-approve`；cursor-agent 位置参数 + `--force`。
- 「自动批准」开关（默认开）：勾上才注入上述免确认 flag（无人值守）。⚠️ 会不经询问改文件/跑命令，建议先用 git 管好项目。
- 模型下拉直接列出所有已知编程 CLI（不再只列设置里配过的）。

### 终端模式（第 5 个模式，移植自 clink）
- 后端 `portable-pty` + `spawn_pty/write_pty/resize_pty/close_pty`；前端 xterm + Pane 分屏。
- 点顶栏「终端」标签即分屏：进入 = 1 屏，再点 = 2、3 屏（封顶 3，防误触塌屏）。
- ⌘C 复制 / ⌘V 粘贴 / ⌘K 清屏；切模式不退 PTY。

### 其它
- 启动即终端（默认 mode = term）。
- 打包：`npm run tauri build` → `cp -R council.app /Applications/`（覆盖前先 pkill）。
