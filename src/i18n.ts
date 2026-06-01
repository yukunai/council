// Lightweight i18n for council. The Chinese catalog (ZH) is the source of truth; per-language
// maps are merged in from ./i18n-strings. Missing keys fall back en → zh → key. UI elements carry
// data-i18n / data-i18n-html / data-i18n-ph / data-i18n-title attributes; applyI18n() fills them.
import { STRINGS as TRANSLATED } from "./i18n-strings";

export type Lang =
  | "zh" | "en" | "es" | "pt" | "fr" | "de" | "ja" | "ko" | "vi" | "id" | "hi" | "th" | "tr" | "ar";

export const LANGS: { code: Lang; label: string }[] = [
  { code: "zh", label: "中文" },
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "pt", label: "Português" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "vi", label: "Tiếng Việt" },
  { code: "id", label: "Bahasa Indonesia" },
  { code: "hi", label: "हिन्दी" },
  { code: "th", label: "ไทย" },
  { code: "tr", label: "Türkçe" },
  { code: "ar", label: "العربية" },
];

// Chinese source catalog. Keys are stable; values are what the app shipped in originally.
export const ZH: Record<string, string> = {
  // toolbar
  "tagline": "多模型工作流",
  "mode.pipe": "流水线",
  "mode.geo": "单篇",
  "mode.rt": "圆桌",
  "mode.code": "协作编程",
  "mode.term": "终端",
  "nav.skills": "技能",
  "nav.addStep": "＋ 步骤",
  "nav.market": "模型市场",
  "nav.settings": "厂商 / 命令 / Key",
  "nav.history": "历史",
  "btn.run": "▶ 运行",
  "btn.stop": "■ 停止",
  // workflow bar
  "wf.label": "工作流",
  "wf.namePh": "给这条工作流起个名",
  "wf.save": "保存",
  "wf.loadPh": "载入已存…",
  "wf.new": "新建空白",
  "wf.del": "删除",
  // skills sidebar
  "skills.libTitle": "技能库",
  "skills.all": "⛶ 全部",
  "skills.allTitle": "打开技能库大窗口，按分类浏览",
  "skills.new": "＋ 新建",
  "skills.repo": "⇄ 仓库",
  "skills.note": "SKILL.md 技能，挂到步骤上会作为该步的系统提示。",
  "side.splitterTitle": "拖动调整技能栏宽度",
  // pipeline editor
  "pipe.inputLabel": "输入（用 <code>{{input}}</code> 引用）",
  "pipe.inputPh": "整条工作流要处理的素材，比如一段原始文案 / 主题…",
  "pipe.refHint": "占位符：<code>{{input}}</code> 初始输入 · <code>{{prev}}</code> 上一步输出 · <code>{{1}}</code><code>{{2}}</code>… 第 N 步输出",
  // GEO (single article) editor
  "geo.titleLabel": "标题 / 主题",
  "geo.titlePh": "比如：家用咖啡机怎么选 / 2026 川西环线自驾指南",
  "geo.materialLabel": "原文 / 素材（可选，贴进来会直接改写成文章）",
  "geo.materialPh": "把要改写的原文、笔记、要点直接贴这里——不用是链接或地点",
  "geo.sourceLabel": "参考链接（可选，填了会抓取正文并改写）",
  "geo.sourcePh": "https://… 留空则按上面的素材 / 下面的要素原创",
  "geo.routeLabel": "路线 / 地点（可选，地名直接写，按顺序）",
  "geo.routePh": "留空就是普通文章；填了会按地点成章，如：成都 → 折多山 → 新都桥",
  "geo.styleLabel": "风格",
  "geo.lenLabel": "篇幅：约 {n} 字",
  "geo.paramHead": "参数池（可选，注入文章的变量）",
  "geo.paramAdd": "＋ 加一项",
  "geo.cardHead": "地点卡片（可选，可拖拽排序）",
  "geo.cardAdd": "＋ 加地点",
  "geo.modelLabel": "模型",
  "geo.skillLabel": "GEO 技能（可选）",
  "geo.imageLabel": "配图来源（可选，CLI 出 SVG / 火山出实图）",
  "geo.refHint": "输出：带 H1–H4 层级的结构文 + 一条小推文（同次生成）。每个标题段都自成一段、能单独读懂。右侧结果可直接改。",
  // round-table editor
  "rt.questionLabel": "问题 / 议题",
  "rt.questionPh": "想让几个模型一起讨论的问题，比如：我这个桌面应用该用 Tauri 还是 Electron？为什么？",
  "rt.roleLabel": "讨论指令 / 角色（可选，对所有参与者生效）",
  "rt.rolePh": "比如：你们是一个务实的技术评审会，敢于反驳、看重依据",
  "rt.partHead": "参与模型（按接力顺序，可拖拽排序）",
  "rt.addOne": "＋ 加一位",
  "rt.roundsLabel": "轮数：{n} 轮（每轮所有人各改进一次）",
  "rt.moderatorLabel": "主持人（最后综述用）",
  "rt.refHint": "接力改进：第 1 位起草，后面每位在上一位的答案上改进；跑完所有轮后，主持人综述「共识 / 分歧 / 最终建议」。右侧每张结果都能直接改。",
  // collaborative coding editor
  "code.dirLabel": "项目文件夹（Agent 会在这里真改文件）",
  "code.dirPh": "点右边选择 / 新建，或手动填绝对路径",
  "code.pick": "选择文件夹",
  "code.newFolder": "新建文件夹",
  "code.taskLabel": "任务 / 需求",
  "code.histOpen": "📋 历史任务",
  "code.taskPh": "想让它们一起做的事，比如：给这个项目加一个登录页，含表单校验和单元测试",
  "code.roleLabel": "协作约定（可选，对所有 Agent 生效）",
  "code.rolePh": "比如：改动尽量小、保持代码风格一致、不新增依赖",
  "code.agentHead": "参与 Agent（仅本地 CLI，按接力顺序，可拖拽）",
  "code.addOne": "＋ 加一位",
  "code.auto": "自动批准（无人值守，免确认）",
  "code.loopPre": "持续协作：每",
  "code.loopSuf": "分钟各 Agent 自动巡检一次，有新内容/问题就处理，不停留 · ⚠️ 持续耗 token",
  "code.refHint": "点「运行」→ 切到终端，每个 Agent 各开一个<strong>实时交互终端</strong>、并排在同一文件夹里干活（你能实时看、随时打字让它改）。队友通过项目根的 <code>TEAM_NOTES.md</code> 互通反馈。勾了「自动批准」就无人值守（Claude <code>--dangerously-skip-permissions</code>、Codex <code>--dangerously-bypass-approvals-and-sandbox</code>、Gemini <code>--yolo</code>、Grok <code>--always-approve</code>、Cursor <code>--force</code>）—— ⚠️ 它会不经询问改文件 / 跑命令，<strong>务必先用 git 管好该项目</strong>以便回滚。",
  // terminal toolbar
  "term.loopLabel": "持续协作",
  "term.stopAll": "■ 全部停止",
  "term.stopAllTitle": "停止所有 AI 的持续协作并中断当前动作",
  "term.startAll": "▶ 全部开启",
  "term.startAllTitle": "恢复所有 AI 的持续协作",
  "term.colSplitterTitle": "拖动调整左右宽度",
  // market modal
  "market.title": "模型市场",
  "market.note": "一键添加。HTTP 厂商添加后到「厂商 / 命令 / Key」填 API Key；本地 CLI 需要你机器上已装好对应命令。端点和模型名随厂商更新会变，添加后都能自行修改。",
  "market.secHttp": "HTTP 厂商（OpenAI 兼容）",
  "market.secCli": "本地命令行（调本机 CLI，不走 API）",
  "market.secVideo": "视频生成（异步任务，出可播放视频）",
  "market.secImage": "图片生成（文生图，出图片）",
  "market.done": "完成",
  // settings modal
  "settings.title": "厂商 / 命令 / Key",
  "settings.note": "HTTP 厂商：Endpoint 填到 <code>/chat/completions</code> 为止，Key 只存在本机。本地命令：填程序名和固定参数，运行时指令会作为最后一个参数传入（如 <code>claude -p &lt;指令&gt;</code>）。",
  "settings.secHttp": "HTTP 厂商",
  "settings.addProvider": "＋ 加一个厂商",
  "settings.secCli": "本地命令行",
  "settings.addCli": "＋ 加一个命令",
  "settings.secVideo": "视频生成（火山方舟 / Seedance 等，异步任务）",
  "settings.addVideo": "＋ 加一个视频源",
  "settings.secImage": "图片生成（文生图，如火山 Seedream）",
  "settings.addImage": "＋ 加一个图片源",
  "settings.cancel": "取消",
  "settings.save": "保存",
  // term-skill modal
  "tsk.title": "发送技能到终端",
  "tsk.note": "点一个技能，把它的正文作为一条消息发给当前终端里运行的 CLI（对话中随时可发）。",
  "tsk.searchPh": "筛选 name / 描述…",
  "tsk.close": "关闭",
  // skill editor modal
  "skill.newTitle": "新建技能",
  "skill.nameLabel": "名称（英文/数字，作文件夹名）",
  "skill.descLabel": "描述（一句话）",
  "skill.descPh": "把文案改得更有网感",
  "skill.catLabel": "分类（可选，自由填，如 写作 / 编程 / 设计；用于技能库归类）",
  "skill.catPh": "选已有或直接输新分类（如 写作）",
  "skill.bodyLabel": "正文（指令本体，会作为系统提示）",
  "skill.bodyPh": "你是资深广告文案……",
  "skill.delete": "删除",
  "skill.cancel": "取消",
  "skill.save": "保存",
  // sync modal
  "sync.title": "技能库仓库同步",
  "sync.note": "技能库在 <code>~/.council/skills</code>。下载会把仓库里所有含 SKILL.md 的文件夹拷进来；上传会把整个技能库 commit 后 push 到你指定的仓库（用你本机的 git 凭证）。",
  "sync.dlLabel": "下载：git 仓库 URL",
  "sync.dlBtn": "下载",
  "sync.upLabel": "上传：目标仓库 URL",
  "sync.upMsgPh": "提交说明（可留空）",
  "sync.upBtn": "上传",
  "sync.importLabel": "从本地导入：选一个 SKILL.md 文件，或一个装有技能子文件夹的目录，拷进技能库",
  "sync.importFile": "选文件",
  "sync.importDir": "选文件夹",
  "sync.close": "关闭",
  // skills library modal
  "skl.title": "技能库",
  "skl.searchPh": "搜索技能名 / 描述…",
  "skl.new": "＋ 新建技能",
  "skl.repo": "⇄ 仓库",
  "skl.close": "关闭",
  // code-history modal
  "ch.title": "协作编程 · 历史任务",
  "ch.note": "每次「运行」自动存一份配置（目录 + 任务 + Agents，最近 30 份，存本机）。点一条即填回表单。",
  "ch.clear": "清空",
  "ch.close": "关闭",
  // run-history modal
  "hist.title": "运行历史",
  "hist.note": "流水线 / 圆桌 / GEO 每次运行完自动存结果；协作编程任务（标「协作编程」）也在这里，点它即填回表单继续。点左侧条目查看 / 加载，可删除。",
  "hist.clear": "清空历史",
  "hist.copy": "复制本条",
  "hist.close": "关闭",
  "lang.label": "语言",
};

// Keys whose values contain inline HTML (set via innerHTML, not textContent). Translators must
// preserve the tags / {{...}} literals / command flags verbatim.
export const HTML_KEYS = new Set<string>([
  "pipe.inputLabel",
  "pipe.refHint",
  "geo.refHint",
  "rt.refHint",
  "code.refHint",
  "settings.note",
  "sync.note",
]);

const LS_LANG = "council.lang";
const STRINGS: Record<Lang, Record<string, string>> = { zh: ZH, ...TRANSLATED } as Record<
  Lang,
  Record<string, string>
>;

function detect(): Lang {
  const n = (navigator.language || "zh").slice(0, 2).toLowerCase();
  return (LANGS.some((l) => l.code === n) ? n : "zh") as Lang;
}
let cur: Lang = ((localStorage.getItem(LS_LANG) as Lang) || detect()) as Lang;
if (!LANGS.some((l) => l.code === cur)) cur = "zh";

export function getLang(): Lang {
  return cur;
}
export function setLang(l: Lang) {
  cur = l;
  localStorage.setItem(LS_LANG, l);
}
// Look up a key for the current language, falling back en → zh → the key itself.
export function t(key: string): string {
  return STRINGS[cur]?.[key] ?? STRINGS.en?.[key] ?? ZH[key] ?? key;
}
// Like t() but interpolates {name} placeholders.
export function tf(key: string, vars: Record<string, string | number>): string {
  return t(key).replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
}
// Fill every data-i18n* element under root with the current language's strings.
export function applyI18n(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n!);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-html]").forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml!);
  });
  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-i18n-ph]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPh!);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle!);
  });
  document.documentElement.lang = cur;
  document.documentElement.dir = cur === "ar" ? "rtl" : "ltr";
}
