import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import {
  parseModels,
  parseArgs,
  fillTemplate,
  skillBody,
  cnLen,
  splitGeo,
  extractSvg,
  sanitizeSvg,
  decodeWorker,
} from "./utils";

// Surface otherwise-silent runtime errors (incl. init-time) instead of a dead-looking UI.
// Registered first so it catches throws during the rest of module evaluation.
window.addEventListener("error", (e) => {
  const el = document.querySelector(".tagline");
  if (el) el.textContent = "脚本错误：" + (e.message || "见控制台");
});
window.addEventListener("unhandledrejection", (e) => {
  const r = (e as PromiseRejectionEvent).reason;
  const el = document.querySelector(".tagline");
  if (el) el.textContent = "未处理错误：" + ((r && (r.message || r)) || "见控制台");
});

// Mirrors the Rust StreamEvent enum (serde tag = "type", lowercase variants).
type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "video"; url: string }
  | { type: "done" }
  | { type: "error"; message: string };

interface Provider {
  name: string;
  endpoint: string;
  key: string;
  models: string; // one model name per line / comma
}
// A local CLI agent worker: prompt is passed as the final argument (claude -p <prompt>).
interface Cli {
  name: string;
  program: string;
  args: string; // space-separated fixed args
}
// An async video-generation source (Volcengine Ark / Seedance task API).
interface VideoProvider {
  name: string;
  endpoint: string;
  key: string;
  models: string;
  resolution: string;
  ratio: string;
  duration: string; // seconds, as string for the input field
}
interface Step {
  title: string;
  worker: string; // "m::<provider>::<model>" or "cli::<name>"
  role: string;
  prompt: string;
  skill?: string; // attached skill name (its body becomes system prompt)
}
interface SkillInfo {
  name: string;
  description: string;
  category: string; // free-form group label (frontmatter `category:`), "" = 未分类
}

// ---- GEO 单篇 ----
interface GeoCard {
  place: string;
  note: string;
}
// A text-to-image source (Volcengine Ark / Seedream, OpenAI-images compatible).
interface ImageProvider {
  name: string;
  endpoint: string;
  key: string;
  models: string;
  size: string;
}
interface GeoState {
  title: string;
  route: string;
  source: string; // optional URL to read & rewrite from
  material: string; // optional raw text to rewrite directly
  params: { k: string; v: string }[];
  style: string;
  length: number;
  worker: string;
  skill: string;
  image: string; // 配图来源: "" | "cli::<name>" (SVG) | "img::<name>::<model>" (real image)
  cards: GeoCard[];
}

const LS_PROVIDERS = "council.providers";
const LS_CLIS = "council.clis";
const LS_VIDEOS = "council.videos";
const LS_PIPELINE = "council.pipeline";
const LS_INPUT = "council.input";
const LS_GEO = "council.geo";
const LS_MODE = "council.mode";

const GEO_STYLES: { key: string; label: string; hint: string }[] = [
  { key: "geo", label: "GEO 结构文", hint: "中性客观、信息密度高、便于被 AI 搜索引擎摘录引用" },
  { key: "xhs", label: "小红书风", hint: "口语、有钩子标题、分点、适度 emoji" },
  { key: "travel", label: "专业游记", hint: "细节丰富、叙事流畅、带实用攻略" },
  { key: "history", label: "历史科普", hint: "严谨、引经据典、讲清来龙去脉" },
  { key: "essay", label: "散文叙事", hint: "文学性、画面感、第一人称" },
  { key: "ai", label: "AI / 科技", hint: "讲清原理与应用、术语准确、面向从业者" },
  { key: "business", label: "商业金融", hint: "结构清晰、有数据与案例、决策导向" },
  { key: "finance", label: "财经", hint: "宏观视角、行情与政策解读、谨慎严谨" },
  { key: "medical", label: "医疗保险", hint: "权威循证、风险提示、不夸大疗效、合规" },
  { key: "tweet", label: "推文 / 短帖", hint: "短平快、钩子开场、口语、信息浓缩、适合社媒分发" },
];

// 内置 GEO 规范：核心是「每个标题段自足」——能被 AI 搜索单独摘出来读懂。
// 这些结构规则对所有风格、所有单篇都适用；风格只改语气，不改结构。
const GEO_BODY = `你是中文内容写作专家，按生成式引擎优化（GEO）的方式写作。无论选什么风格，下面的结构规则都必须严格遵守：
- 用 Markdown 标题层级组织：一个 # H1 标题，多个 ## H2 章节，必要时用 ### H3、#### H4 细分。
- 每个标题写成清晰具体的问题或要点，单看标题就知道这节讲什么；别用「引言 / 背景 / 概述 / 总结」这类空泛标题。
- 最关键——每个标题下的内容都要「自足」：本节内把这个话题说完整、能被 AI 搜索单独摘出来读懂，不依赖上一节或下一节，绝不写「如前所述 / 见下文 / 上面提到 / 综上」这类交叉引用。
- answer-first 落到每一节：每节开头第一句先直接回答本节标题，再展开论据和细节；全文第一段也先用一两句给出核心结论 / 这篇能解决什么。
- 段落要短：每个标题下分成 2~3 个自然段，每段约 2~4 句话，不堆大段；并列信息用要点列表。
- 信息要实：给具体的事实、数字、步骤、例子，少用形容词堆砌。禁止「在当今时代 / 随着……的发展 / 总而言之 / 不仅……而且」这类套话空话，不写没信息量的过渡句。
- 如果给了路线或多个地点，按给定顺序成章；没给地点就当普通文章写，不要硬凑地理内容。
- 结尾加「## 常见问题」，用 ### 列 3 条左右独立问答，每条问答也要能被单独摘出来读懂。
- 篇幅贴近目标字数（控制在 ±15% 以内），不灌水也不草草收尾。`;

const GEO_CONTRACT = `全文写完后，另起一行单独输出这一行分隔符（独占一行，就是这串字符）：
===小推文===
然后写一条社媒小推文：≤140 字，一句钩子开头，点出文章最核心的价值或反常识结论，可带 1~3 个话题标签，语气贴合所选风格；只写推文本身，不加引号、不解释。`;

const DEFAULT_GEO: GeoState = {
  title: "",
  route: "",
  source: "",
  material: "",
  params: [],
  style: "geo",
  length: 800,
  worker: "",
  skill: "",
  image: "",
  cards: [],
};

const LS_IMAGES = "council.images";
const DEFAULT_IMAGES: ImageProvider[] = [];
const IMAGE_PRESETS: ImageProvider[] = [
  {
    name: "火山 即梦/Seedream 文生图",
    endpoint: "https://ark.cn-beijing.volces.com/api/v3/images/generations",
    key: "",
    models: "doubao-seedream-4-0-250828",
    size: "1024x1024",
  },
];

const GEO_IMG_CONTRACT = `这篇文章需要配图。请在合适位置（通常每个主要章节配 1 张）单独用一行插入配图标记，格式严格为：
[[IMG: 一句中文画面描述，说清这张图画什么]]
全文插入 2~4 个标记，每个标记独占一行；正文照常写，不要解释这些标记。`;

const DEFAULT_PROVIDERS: Provider[] = [
  {
    name: "DeepSeek",
    endpoint: "https://api.deepseek.com/chat/completions",
    key: "",
    models: "deepseek-v4-pro\ndeepseek-v4-flash\ndeepseek-chat\ndeepseek-reasoner",
  },
];

const DEFAULT_CLIS: Cli[] = [{ name: "Claude Code", program: "claude", args: "-p" }];

const DEFAULT_VIDEOS: VideoProvider[] = [];

// Video presets for the market.
const VIDEO_PRESETS: VideoProvider[] = [
  {
    name: "火山 即梦 / Seedance",
    endpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
    key: "",
    models: "doubao-seedance-2-0-260128",
    resolution: "1080p",
    ratio: "16:9",
    duration: "5",
  },
];

const DEFAULT_STEPS: Step[] = [
  {
    title: "写脚本",
    worker: "",
    role: "你是短视频脚本写手，输出口语化、有节奏感。",
    prompt: "根据下面的主题，写一条 60 秒短视频口播脚本：\n\n{{input}}",
  },
  {
    title: "改文案",
    worker: "",
    role: "你是广告文案，擅长把内容改得更有网感。",
    prompt: "把下面这版脚本改写得更有传播力，保留信息但更抓人：\n\n{{prev}}",
  },
];

// 模型市场预设。DeepSeek/Kimi/千问/Gemini/GLM/Mistral/xAI 的端点是 2026-05 查官方文档得到的；
// OpenAI 用已知模型名（文档页要登录）；火山端点固定但豆包模型名按账号调；MiniMax 端点留空待确认。
// 模型名随厂商更新会变，添加后都能在「厂商 / 命令 / Key」里改。
interface Preset {
  name: string;
  endpoint: string;
  models: string;
  note?: string;
  soon?: boolean;
}
const PRESETS: Preset[] = [
  {
    name: "DeepSeek",
    endpoint: "https://api.deepseek.com/chat/completions",
    models: "deepseek-v4-pro\ndeepseek-v4-flash\ndeepseek-chat\ndeepseek-reasoner",
  },
  {
    name: "OpenAI (GPT)",
    endpoint: "https://api.openai.com/v1/chat/completions",
    models: "gpt-4o\ngpt-4o-mini\ngpt-4.1\ngpt-4.1-mini\no3\no4-mini",
  },
  {
    name: "Gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    models: "gemini-3.5-flash\ngemini-3.1-pro\ngemini-3.5-flash-lite\ngemini-2.5-flash",
  },
  {
    name: "千问 阿里百炼",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    models: "qwen-max\nqwen-plus\nqwen-flash\nqwen-turbo\nqwq-plus",
  },
  {
    name: "Kimi 月之暗面",
    endpoint: "https://api.moonshot.cn/v1/chat/completions",
    models:
      "kimi-k2.6\nkimi-k2.5\nkimi-k2-thinking\nmoonshot-v1-128k\nmoonshot-v1-32k\nmoonshot-v1-8k\nmoonshot-v1-auto",
  },
  {
    name: "GLM 智谱",
    endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    models: "glm-5.1\nglm-4.7\nglm-4.6v\nglm-4-flash",
  },
  {
    name: "xAI Grok",
    endpoint: "https://api.x.ai/v1/chat/completions",
    models: "grok-4.3\ngrok-3",
  },
  {
    name: "Mistral",
    endpoint: "https://api.mistral.ai/v1/chat/completions",
    models: "mistral-large-latest\nmistral-small-latest",
  },
  {
    name: "火山方舟 豆包",
    endpoint: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
    models: "doubao-1.5-pro-32k\ndoubao-1.5-pro-256k\ndoubao-1.5-lite-32k",
    note: "model 处可填模型名，或你在方舟控制台创建的接入点 ID（ep-…）",
  },
  {
    name: "Ollama 本地 (Llama 等)",
    endpoint: "http://localhost:11434/v1/chat/completions",
    models: "llama3.3\nllama3.1\nqwen2.5\nmistral",
    note: "本机 Ollama：先 `ollama pull` 模型；Key 随便填个非空值即可。",
  },
  {
    name: "MiniMax",
    endpoint: "",
    models: "MiniMax-M2.7\nMiniMax-M2.5\nMiniMax-M2.1",
    note: "MiniMax 接口与标准 OpenAI 略有差异，请到其文档确认 Endpoint 与模型 ID 后填入。",
  },
  {
    name: "Claude（Anthropic）",
    endpoint: "",
    models: "",
    note: "Anthropic 接口非 OpenAI 格式，HTTP 这边接不了。请用下方『本地命令行 · Claude Code』。",
    soon: true,
  },
  {
    name: "即梦 Jimeng（视频）",
    endpoint: "",
    models: "",
    note: "视频生成走异步任务，已在下方『视频生成』分区，添加火山 即梦/Seedance 即可。",
    soon: true,
  },
];

// 本地 CLI 预设。claude -p 已验证；codex exec / gemini -p 较有把握；grok 参数按你的 CLI 调整。
const CLI_PRESETS: { name: string; program: string; args: string; note?: string }[] = [
  { name: "Claude Code", program: "claude", args: "-p" },
  { name: "Codex (GPT)", program: "codex", args: "exec --skip-git-repo-check" },
  { name: "Gemini CLI", program: "gemini", args: "-p --skip-trust" },
  { name: "Grok CLI", program: "grok", args: "-p", note: "grok -p <提示>（单轮，打印到 stdout）；用法不同就改这里" },
  {
    name: "Cursor Agent",
    program: "cursor-agent",
    args: "-p --force",
    note: "Cursor CLI：先 `cursor-agent login` 登录；-p 单轮打印、--force 免确认（协作编程改文件需要，纯问答可去掉）",
  },
];

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

let providers: Provider[] = load(LS_PROVIDERS, DEFAULT_PROVIDERS);
let clis: Cli[] = load(LS_CLIS, DEFAULT_CLIS);
let videos: VideoProvider[] = load(LS_VIDEOS, DEFAULT_VIDEOS);
let steps: Step[] = load(LS_PIPELINE, DEFAULT_STEPS);
let skills: SkillInfo[] = [];
// Skills checked in the left library = "default skills": auto-applied when launching a
// terminal or running 协作编程 (on top of any per-agent skills).
const LS_DEFAULT_SKILLS = "council.defaultskills";
let defaultSkills: string[] = load(LS_DEFAULT_SKILLS, []);
function saveDefaultSkills() {
  localStorage.setItem(LS_DEFAULT_SKILLS, JSON.stringify(defaultSkills));
}
// User-created categories (so an empty category can exist before any skill uses it).
const LS_SKILL_CATS = "council.skillcats";
let customCategories: string[] = load(LS_SKILL_CATS, []);
function saveCustomCats() {
  localStorage.setItem(LS_SKILL_CATS, JSON.stringify(customCategories));
}
// Current category filter in the left skill sidebar.
let sidebarCat = "全部";
// All categories = those used by skills + the user-created ones (deduped, sorted).
function allCategories(): string[] {
  const used = skills.map((s) => s.category.trim()).filter(Boolean);
  return [...new Set([...used, ...customCategories])].sort((a, b) => a.localeCompare(b, "zh"));
}
// Merge over defaults so a geo object persisted by an older build (missing newer
// fields like source/material/image) doesn't blow up on access.
let geo: GeoState = { ...DEFAULT_GEO, ...load(LS_GEO, {}) };
let images: ImageProvider[] = load(LS_IMAGES, DEFAULT_IMAGES);
// Default to pipeline (the primary workflow). LS_MODE is saved on switch but we deliberately
// do NOT restore it at cold launch — user always starts on a focused primary view.
// "term" is still reachable via the segmented button and spawns panes on demand.
let mode: string = "pipe";
if (!["pipe", "geo", "rt", "code", "term"].includes(mode)) mode = "pipe";

// One-time arg fixes for CLIs added before the presets were corrected:
//  - grok with empty args fails ("unrecognized subcommand") → needs `-p`.
//  - codex/gemini refuse to run headless outside a trusted/git dir (圆桌/流水线 run them
//    via piped stdio in the app's cwd) → codex needs `--skip-git-repo-check`, gemini `--skip-trust`.
{
  let fixed = false;
  const ensure = (c: Cli, flag: string) => {
    if (!c.args.split(/\s+/).includes(flag)) {
      c.args = `${c.args} ${flag}`.trim();
      fixed = true;
    }
  };
  for (const c of clis) {
    const prog = c.program.trim();
    if (prog === "grok" && !c.args.trim()) {
      c.args = "-p";
      fixed = true;
    }
    if (prog === "codex") ensure(c, "--skip-git-repo-check");
    if (prog === "gemini") ensure(c, "--skip-trust");
  }
  if (fixed) saveClis();
}
function saveGeo() {
  localStorage.setItem(LS_GEO, JSON.stringify(geo));
}
function saveImages() {
  localStorage.setItem(LS_IMAGES, JSON.stringify(images));
}

// ---- 圆桌 (round-table): one question, several models improve a shared answer in
// relay order over N rounds, then a moderator model synthesizes 共识/分歧/最终建议. ----
interface RtParticipant {
  worker: string; // model worker value
  skill: string; // optional attached skill (its body joins this one's system prompt)
}
interface RoundtableState {
  question: string;
  role: string; // optional shared system instruction for all participants
  participants: RtParticipant[]; // in relay order, each model with its own optional skill
  rounds: number;
  moderator: string; // worker value used for the final synthesis
}
const LS_RT = "council.rt";
const DEFAULT_RT: RoundtableState = { question: "", role: "", participants: [], rounds: 2, moderator: "" };
let rt: RoundtableState = { ...DEFAULT_RT, ...load(LS_RT, {}) };
// Normalize participants: tolerate the earlier shape where each was a bare worker string.
rt.participants = (rt.participants as unknown[]).map((p) =>
  typeof p === "string"
    ? { worker: p, skill: "" }
    : { worker: (p as RtParticipant).worker ?? "", skill: (p as RtParticipant).skill ?? "" },
);
function saveRt() {
  localStorage.setItem(LS_RT, JSON.stringify(rt));
}

// ---- 协作编程 (collaborative coding): several local CLI agents take turns editing the
// files in one project folder — agent 1 implements, the rest review / fix / continue. ----
interface CodeAgent {
  worker: string; // CLI worker value ("cli::<name>")
  duty: string; // this agent's responsibility (实现 / 审查 / 测试 …)
  skills: string[]; // attached skills (their bodies join this agent's system prompt)
}
interface CodingState {
  dir: string; // absolute project folder; agents run with this as cwd
  task: string;
  role: string; // optional shared convention for all agents (style, no new deps…)
  agents: CodeAgent[]; // each gets its own live terminal, by duty
  auto: boolean; // inject each CLI's auto-approve flag so it runs unattended (no prompts)
  loop: boolean; // 持续协作: periodically re-prompt each agent to re-scan (infinite loop)
  loopMins: number; // 持续协作 interval in minutes (user-configurable)
}
const LS_CODE = "council.code";
const DEFAULT_CODE: CodingState = { dir: "", task: "", role: "", agents: [], auto: true, loop: false, loopMins: 2.5 };
// Active 持续协作 re-scan timers (cleared on re-run / leaving the run).
let codeLoopTimers: number[] = [];
function clearCodeLoop() {
  codeLoopTimers.forEach((t) => clearInterval(t));
  codeLoopTimers = [];
}
let code: CodingState = { ...DEFAULT_CODE, ...load(LS_CODE, {}) };
// How to launch each CLI interactively, seeded with a task prompt, optionally unattended.
// `auto` = the flag that disables "allow this action?" prompts. `promptArg`: true → pass
// the prompt as a positional arg; false → CLI rejects a positional prompt (e.g. grok),
// so launch bare and type the prompt into its stdin after it starts.
interface CliLaunch {
  auto: string[];
  promptArg: boolean;
  accept?: string; // keystrokes auto-sent after launch to clear a startup confirm dialog
}
const CLI_LAUNCH: Record<string, CliLaunch> = {
  // claude --dangerously-skip-permissions shows a one-time "Yes, I accept" menu (default
  // on "1. No"); auto-send Down+Enter to pick "2. Yes" so it runs unattended.
  claude: { auto: ["--dangerously-skip-permissions"], promptArg: true, accept: "\x1b[B\r" },
  codex: { auto: ["--dangerously-bypass-approvals-and-sandbox"], promptArg: true },
  gemini: { auto: ["--yolo"], promptArg: true },
  grok: { auto: ["--always-approve"], promptArg: false },
  "cursor-agent": { auto: ["--force"], promptArg: true },
};
// The coding CLIs we know how to drive (value = bare program name); the 协作编程 model
// dropdown offers these without needing them pre-added in 设置.
const CODING_CLIS = [
  { program: "claude", label: "Claude Code" },
  { program: "codex", label: "Codex" },
  { program: "gemini", label: "Gemini" },
  { program: "grok", label: "Grok" },
  { program: "cursor-agent", label: "Cursor" },
];
// Normalize agents: tolerate earlier shapes (bare worker string; single `skill`; and
// the old "cli::<name>" worker → bare program name when it's a known coding CLI).
code.agents = (code.agents as unknown[]).map((a) => {
  if (typeof a === "string") return { worker: a, duty: "", skills: [] };
  const o = a as { worker?: string; duty?: string; skill?: string; skills?: string[] };
  const skills = Array.isArray(o.skills) ? o.skills : o.skill ? [o.skill] : [];
  let worker = o.worker ?? "";
  if (worker.startsWith("cli::")) {
    const c = clis.find((x) => `cli::${x.name}` === worker);
    if (c && CODING_CLIS.some((k) => k.program === c.program)) worker = c.program;
  }
  return { worker, duty: o.duty ?? "", skills };
});
function saveCode() {
  localStorage.setItem(LS_CODE, JSON.stringify(code));
}

// ---- 协作编程·历史任务: each run snapshots its config so older tasks aren't overwritten and
// can be reloaded into the form (the regular 运行历史 only covers result-producing modes). ----
interface CodeTask {
  id: string;
  at: number;
  title: string;
  dir: string;
  task: string;
  role: string;
  agents: CodeAgent[];
  auto: boolean;
  loop: boolean;
  loopMins: number;
}
const LS_CODE_HIST = "council.codehist";
let codeHist: CodeTask[] = load(LS_CODE_HIST, []);
function saveCodeHist() {
  localStorage.setItem(LS_CODE_HIST, JSON.stringify(codeHist));
}
function pushCodeTask() {
  if (!code.task.trim() && !code.dir.trim()) return;
  const title = (code.task.trim().split("\n").find((l) => l.trim()) || code.dir.trim() || "未命名任务").slice(0, 50);
  const snap: CodeTask = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    at: Date.now(),
    title,
    dir: code.dir,
    task: code.task,
    role: code.role,
    agents: JSON.parse(JSON.stringify(code.agents)),
    auto: code.auto,
    loop: code.loop,
    loopMins: code.loopMins,
  };
  // De-dupe: same dir + task replaces the old entry (and floats to the top).
  codeHist = codeHist.filter((t) => !(t.dir === snap.dir && t.task === snap.task));
  codeHist.unshift(snap);
  if (codeHist.length > 30) codeHist.length = 30;
  saveCodeHist();
}

// Suggested duties pre-filled as agents are added, so the division of labor is clear.
const DUTY_SUGGEST = ["实现功能", "审查 + 修 bug", "补测试", "重构 / 优化"];

// ---- 运行历史: every completed run is saved (newest first, capped) so it can be re-read. ----
interface HistEntry {
  id: string;
  time: number;
  mode: string; // pipe | geo | rt | code
  title: string;
  md: string;
}
const LS_HISTORY = "council.history";
let history: HistEntry[] = load(LS_HISTORY, []);
const MODE_LABEL: Record<string, string> = { pipe: "流水线", geo: "单篇", rt: "圆桌", code: "协作编程" };
function pushHistory(mode: string, title: string, md: string) {
  if (!md.trim()) return;
  history.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    time: Date.now(),
    mode,
    title: title.trim().slice(0, 60) || "(无题)",
    md,
  });
  if (history.length > 50) history.length = 50;
  saveHistoryLS();
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const inputEl = $<HTMLTextAreaElement>("#pipe-input");
const stepsEl = $<HTMLDivElement>("#steps");
const resultsEl = $<HTMLDivElement>("#results-list");
const runBtn = $<HTMLButtonElement>("#run-btn");
const stopBtn = $<HTMLButtonElement>("#stop-btn");
const settingsModal = $<HTMLDivElement>("#settings-modal");
const providersList = $<HTMLDivElement>("#providers-list");
const clisList = $<HTMLDivElement>("#clis-list");
const marketModal = $<HTMLDivElement>("#market-modal");
const marketList = $<HTMLDivElement>("#market-list");
const marketCliList = $<HTMLDivElement>("#market-cli-list");
const marketVideoList = $<HTMLDivElement>("#market-video-list");
const marketImageList = $<HTMLDivElement>("#market-image-list");
const videosList = $<HTMLDivElement>("#videos-list");
const imagesList = $<HTMLDivElement>("#images-list");
const wfNameEl = $<HTMLInputElement>("#wf-name");
const wfLoadEl = $<HTMLSelectElement>("#wf-load");
const skillsPanel = $<HTMLElement>("#skills-panel");
const skillsListEl = $<HTMLDivElement>("#skills-list");
const skillModal = $<HTMLDivElement>("#skill-modal");
const syncModal = $<HTMLDivElement>("#sync-modal");
const syncOutput = $<HTMLPreElement>("#sync-output");

inputEl.value = load(LS_INPUT, "");
inputEl.addEventListener("input", () => localStorage.setItem(LS_INPUT, inputEl.value));

function saveProviders() {
  localStorage.setItem(LS_PROVIDERS, JSON.stringify(providers));
}
function saveClis() {
  localStorage.setItem(LS_CLIS, JSON.stringify(clis));
}
function saveVideos() {
  localStorage.setItem(LS_VIDEOS, JSON.stringify(videos));
}
function saveSteps() {
  localStorage.setItem(LS_PIPELINE, JSON.stringify(steps));
}

// parseModels / parseArgs now imported from ./utils (tested)

function workerOptions(): { value: string; label: string }[] {
  const opts: { value: string; label: string }[] = [];
  for (const p of providers) {
    for (const m of parseModels(p.models)) {
      opts.push({ value: `m::${p.name}::${m}`, label: `${p.name} · ${m}` });
    }
  }
  for (const c of clis) {
    opts.push({ value: `cli::${c.name}`, label: `CLI · ${c.name}` });
  }
  for (const v of videos) {
    for (const m of parseModels(v.models)) {
      opts.push({ value: `vid::${v.name}::${m}`, label: `🎬 ${v.name} · ${m}` });
    }
  }
  return opts;
}

// decodeWorker now imported from ./utils (extended with image kind; pure + tested)

// Make sure every step points at a worker that still exists.
function normalizeWorkers(): boolean {
  const opts = workerOptions();
  const valid = new Set(opts.map((o) => o.value));
  const fallback = opts[0]?.value ?? "";
  let changed = false;
  for (const s of steps) {
    if (!valid.has(s.worker)) {
      s.worker = fallback;
      changed = true;
    }
  }
  return changed;
}

// skillBody now imported from ./utils (pure + tested; handles BOM + frontmatter)

// Populate a <select> from {value,label} options, marking `current` selected. Pass
// `none` to prepend a blank "" option (its label) for the no-selection case.
function fillSelect(
  sel: HTMLSelectElement,
  options: { value: string; label: string }[],
  current: string,
  opts: { none?: string } = {},
) {
  sel.innerHTML = "";
  if (opts.none !== undefined) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = opts.none;
    sel.appendChild(o);
  }
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.value === current) opt.selected = true;
    sel.appendChild(opt);
  }
}

// ---- step editor ----
function renderSteps() {
  if (normalizeWorkers()) saveSteps();
  stepsEl.innerHTML = "";
  const opts = workerOptions();
  steps.forEach((step, i) => {
    const card = document.createElement("div");
    card.className = "step";

    const head = document.createElement("div");
    head.className = "step-head";

    const num = document.createElement("div");
    num.className = "step-num";
    num.textContent = String(i + 1);

    const title = document.createElement("input");
    title.className = "step-title";
    title.value = step.title;
    title.placeholder = "这一步做什么";
    title.addEventListener("input", () => {
      step.title = title.value;
      saveSteps();
    });

    const worker = document.createElement("select");
    worker.className = "step-worker";
    fillSelect(worker, opts, step.worker);
    worker.addEventListener("change", () => {
      step.worker = worker.value;
      saveSteps();
    });

    const del = document.createElement("button");
    del.className = "step-del danger";
    del.textContent = "✕";
    del.title = "删除这一步";
    del.addEventListener("click", () => {
      steps.splice(i, 1);
      saveSteps();
      renderSteps();
    });

    head.append(num, title, worker, del);

    // skill picker
    const skillRow = document.createElement("div");
    skillRow.className = "step-row";
    const skillLabel = document.createElement("span");
    skillLabel.className = "wfbar-label";
    skillLabel.textContent = "技能";
    const skill = document.createElement("select");
    skill.className = "col";
    fillSelect(skill, skills.map((s) => ({ value: s.name, label: s.name })), step.skill ?? "", {
      none: "（不挂技能）",
    });
    skill.addEventListener("change", () => {
      step.skill = skill.value || undefined;
      saveSteps();
    });
    skillRow.append(skillLabel, skill);

    const role = document.createElement("input");
    role.className = "step-role";
    role.value = step.role;
    role.placeholder = "角色 / 系统提示（可留空；挂了技能会叠加在前面）";
    role.addEventListener("input", () => {
      step.role = role.value;
      saveSteps();
    });

    const prompt = document.createElement("textarea");
    prompt.rows = 4;
    prompt.value = step.prompt;
    prompt.placeholder = "指令，可用 {{input}} {{prev}} {{1}} 引用素材或上游输出";
    prompt.addEventListener("input", () => {
      step.prompt = prompt.value;
      saveSteps();
    });

    card.append(head, skillRow, role, prompt);
    stepsEl.appendChild(card);
  });
  refreshGeoSelectors();
  refreshRtSelectors();
}

// fillTemplate now imported from ./utils (pure + tested)

// ---- running ----
let running = false;
let cancelCurrent: (() => void) | null = null;
// Bumped on every run start and on stop; an in-flight run whose id no longer matches
// abandons itself after any await, so a hung request (e.g. a slow fetch) can't wedge
// the UI and Stop always unsticks it.
let genId = 0;

// Coalesce result-panel scrolling into one update per frame; scrolling on every
// streamed token forces a layout each time and gets janky on long outputs.
let scrollPending = false;
function scheduleScroll() {
  if (scrollPending) return;
  scrollPending = true;
  requestAnimationFrame(() => {
    scrollPending = false;
    resultsEl.scrollTop = resultsEl.scrollHeight;
  });
}

function makeTextFlusher(el: HTMLElement) {
  let pending: string | null = null;
  let raf = 0;
  const flush = () => {
    raf = 0;
    if (pending === null) return;
    el.textContent = pending;
    pending = null;
  };
  return {
    stream: (text: string) => {
      pending = text;
      if (!raf) raf = requestAnimationFrame(flush);
    },
    flush: () => {
      if (raf) cancelAnimationFrame(raf);
      flush();
    },
    cancel: () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      pending = null;
    },
  };
}

// Shared result-card shell: `.result` > `.result-head`(title … extras … status) > `.result-body`.
// `extras` are extra head elements (worker label, copy/export buttons) placed before status.
function cardShell(
  title: string,
  opts: { extras?: HTMLElement[]; prepend?: boolean; body?: boolean } = {},
): { card: HTMLDivElement; body: HTMLDivElement; setStatus: (s: string, label: string) => void } {
  const card = document.createElement("div");
  card.className = "result";
  const head = document.createElement("div");
  head.className = "result-head";
  const t = document.createElement("span");
  t.textContent = title;
  const status = document.createElement("span");
  status.className = "result-status";
  head.append(t, ...(opts.extras ?? []), status);
  card.appendChild(head);
  const body = document.createElement("div");
  body.className = "result-body";
  if (opts.body !== false) card.appendChild(body);
  if (opts.prepend) resultsEl.prepend(card);
  else resultsEl.appendChild(card);
  return {
    card,
    body,
    setStatus: (s, label) => {
      status.className = `result-status ${s}`;
      status.textContent = label;
    },
  };
}

// Start a run: bump genId, flip to the running UI, clear results. Returns this run's id.
function beginRun(): number {
  const my = ++genId;
  running = true;
  cancelCurrent = null;
  runBtn.classList.add("hidden");
  stopBtn.classList.remove("hidden");
  resultsEl.innerHTML = "";
  return my;
}

// End a run, but only if it's still the current one (a newer run / stop supersedes it).
function endRun(my: number) {
  if (my !== genId) return;
  running = false;
  cancelCurrent = null;
  stopBtn.classList.add("hidden");
  runBtn.classList.remove("hidden");
}

// Lightweight inline toast — replaces native browser dialogs, unreliable in the webview.
function toast(message: string, kind: "info" | "error" = "error") {
  let wrap = document.getElementById("toast-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "toast-wrap";
    document.body.appendChild(wrap);
  }
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 250);
  }, 3200);
}

function runWorker(
  worker: string,
  system: string,
  prompt: string,
  onDelta: (text: string) => void,
  onVideo: (url: string) => void,
  cwd?: string, // CLI workers only: run the agent inside this project folder
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      settled = true;
      cancelCurrent = null;
    };
    // Pressing 停止 resolves the in-flight step immediately; the backend stream may
    // still finish in the background, but we stop listening and move on.
    cancelCurrent = () => {
      if (!settled) {
        finish();
        resolve();
      }
    };
    const channel = new Channel<StreamEvent>();
    channel.onmessage = (ev) => {
      if (settled) return;
      if (ev.type === "delta") onDelta(ev.text);
      else if (ev.type === "video") onVideo(ev.url);
      else if (ev.type === "done") {
        finish();
        resolve();
      } else if (ev.type === "error") {
        finish();
        reject(new Error(ev.message));
      }
    };

    const w = decodeWorker(worker);
    if (w.kind === "cli") {
      const c = clis.find((x) => x.name === w.name);
      if (!c) return reject(new Error(`找不到本地命令：${w.name}`));
      const full = [system, prompt].filter((s) => s.trim()).join("\n\n");
      invoke("cli_run", {
        program: c.program,
        args: parseArgs(c.args),
        prompt: full,
        cwd: cwd || null,
        onEvent: channel,
      }).catch(reject);
      return;
    }

    if (w.kind === "video") {
      const vp = videos.find((x) => x.name === w.provider);
      if (!vp) return reject(new Error(`找不到视频源：${w.provider}`));
      if (!vp.endpoint.trim()) return reject(new Error(`视频源「${vp.name}」没填 Endpoint`));
      if (!vp.key.trim()) return reject(new Error(`视频源「${vp.name}」还没填 API Key`));
      const full = [system, prompt].filter((s) => s.trim()).join("\n\n");
      invoke("video_generate", {
        endpoint: vp.endpoint,
        apiKey: vp.key,
        model: w.model,
        prompt: full,
        resolution: vp.resolution,
        ratio: vp.ratio,
        duration: parseInt(vp.duration, 10) || 0,
        onEvent: channel,
      }).catch(reject);
      return;
    }

    const p = providers.find((x) => x.name === w.provider);
    if (!p) return reject(new Error(`找不到厂商：${w.provider}`));
    if (!p.endpoint.trim()) return reject(new Error(`厂商「${p.name}」没填 Endpoint`));
    if (!p.key.trim()) return reject(new Error(`厂商「${p.name}」还没填 API Key`));

    const messages: { role: string; content: string }[] = [];
    if (system.trim()) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: prompt });
    invoke("chat_stream", {
      url: p.endpoint,
      apiKey: p.key,
      model: w.model,
      messages,
      onEvent: channel,
    }).catch(reject);
  });
}

function workerLabel(worker: string): string {
  const w = decodeWorker(worker);
  if (w.kind === "cli") return `CLI · ${w.name}`;
  if (w.kind === "video") return `🎬 ${w.provider} · ${w.model}`;
  return `${w.provider} · ${w.model}`;
}

function makeResultCard(
  step: Step,
  n: number,
): { body: HTMLDivElement; setStatus: (s: string, label: string) => void } {
  const worker = document.createElement("span");
  worker.className = "result-worker";
  worker.textContent = workerLabel(step.worker) + (step.skill ? ` · 技能:${step.skill}` : "");
  const { body, setStatus } = cardShell(`${n}. ${step.title || "(未命名)"}`, { extras: [worker] });
  return { body, setStatus };
}

async function run() {
  if (running) return;
  if (steps.length === 0) return;
  const my = beginRun();
  try {
    await runSteps(my);
  } finally {
    endRun(my);
  }
}

// The pipeline body, split out so run() can guarantee endRun() in a finally — an
// unexpected throw (not just a worker error) must never leave the UI stuck "running".
async function runSteps(my: number) {
  const input = inputEl.value;
  const outputs: string[] = [];

  // Preload each attached skill's body once.
  const bodies: Record<string, string> = {};
  for (const s of steps) {
    if (s.skill && !(s.skill in bodies)) {
      try {
        bodies[s.skill] = skillBody(await invoke<string>("read_skill", { name: s.skill }));
      } catch {
        bodies[s.skill] = "";
      }
    }
  }
  if (my !== genId) return;

  for (let i = 0; i < steps.length; i++) {
    if (my !== genId) break;
    const step = steps[i];
    const card = makeResultCard(step, i + 1);
    card.setStatus("running", "运行中…");
    const skillText = step.skill ? bodies[step.skill] ?? "" : "";
    const system = [skillText, step.role].map((x) => x.trim()).filter(Boolean).join("\n\n");
    const prompt = fillTemplate(step.prompt, input, outputs, i);
    let acc = "";
    let videoUrl = "";
    const textFlush = makeTextFlusher(card.body);
    try {
      await runWorker(
        step.worker,
        system,
        prompt,
        (text) => {
          acc += text;
          textFlush.stream(acc);
          scheduleScroll();
        },
        (url) => {
          textFlush.flush();
          videoUrl = url;
          const video = document.createElement("video");
          video.className = "result-video";
          video.controls = true;
          video.src = url;
          const link = document.createElement("a");
          link.className = "result-link";
          link.href = url;
          link.target = "_blank";
          link.textContent = "视频链接（24 小时内有效，记得下载）";
          card.body.append(video, link);
          scheduleScroll();
        },
      );
      // downstream steps can reference the video URL via {{prev}} / {{N}}
      textFlush.flush();
      outputs[i] = videoUrl || acc;
      card.setStatus("done", my !== genId ? "已停止" : "完成");
    } catch (e) {
      textFlush.cancel();
      if (my !== genId) break;
      card.body.classList.add("error");
      card.body.textContent = e instanceof Error ? e.message : String(e);
      card.setStatus("error", "出错");
      break;
    }
  }

  if (my === genId && outputs.some((o) => o && o.trim())) {
    const md =
      `# 流水线\n\n**输入**\n\n${input || "(空)"}\n` +
      steps.map((s, i) => `\n\n## ${i + 1}. ${s.title || "(未命名)"}\n\n${outputs[i] ?? ""}`).join("");
    pushHistory("pipe", input.slice(0, 40) || steps[0]?.title || "流水线", md);
  }
}

// ---- settings list helpers (shared by providers / clis / videos / images) ----
// A labeled input or textarea bound to a setter. `col:true` makes it flex-grow in a row.
function fieldCol(
  label: string,
  value: string,
  onInput: (v: string) => void,
  opts: { placeholder?: string; type?: string; rows?: number; col?: boolean } = {},
): HTMLDivElement {
  const col = document.createElement("div");
  if (opts.col) col.className = "col";
  const lab = document.createElement("label");
  lab.textContent = label;
  let inp: HTMLInputElement | HTMLTextAreaElement;
  if (opts.rows) {
    const ta = document.createElement("textarea");
    ta.rows = opts.rows;
    inp = ta;
  } else {
    const input = document.createElement("input");
    if (opts.type) input.type = opts.type;
    inp = input;
  }
  if (opts.placeholder) inp.placeholder = opts.placeholder;
  inp.value = value;
  inp.addEventListener("input", () => onInput(inp.value));
  col.append(lab, inp);
  return col;
}

// First row of every settings card: a name field + a 删除 button.
function settingsHead(name: string, onName: (v: string) => void, onDelete: () => void): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "step-row";
  const del = document.createElement("button");
  del.className = "danger";
  del.textContent = "删除";
  del.addEventListener("click", onDelete);
  row.append(fieldCol("名称", name, onName, { col: true }), del);
  return row;
}

// A row of side-by-side fields/controls.
function fieldRow(...cols: HTMLElement[]): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "step-row";
  row.append(...cols);
  return row;
}

// ---- settings: HTTP providers ----
function renderProviders() {
  providersList.innerHTML = "";
  providers.forEach((p, i) => {
    const box = document.createElement("div");
    box.className = "provider";
    const testStatus = document.createElement("span");
    testStatus.className = "test-status";
    const testBtn = document.createElement("button");
    testBtn.textContent = "测试连通";
    testBtn.addEventListener("click", () => testProvider(p, testStatus));
    box.append(
      settingsHead(p.name, (v) => (p.name = v), () => {
        providers.splice(i, 1);
        renderProviders();
      }),
      fieldCol("Endpoint（到 /chat/completions）", p.endpoint, (v) => (p.endpoint = v), {
        placeholder: "https://api.deepseek.com/chat/completions",
      }),
      fieldCol("API Key", p.key, (v) => (p.key = v), { type: "password", placeholder: "sk-…" }),
      fieldCol("模型（每行一个）", p.models, (v) => (p.models = v), { rows: 3 }),
      fieldRow(testBtn, testStatus),
    );
    providersList.appendChild(box);
  });
}

// ---- settings: local CLI commands ----
function renderClis() {
  clisList.innerHTML = "";
  clis.forEach((c, i) => {
    const box = document.createElement("div");
    box.className = "provider";
    const testStatus = document.createElement("span");
    testStatus.className = "test-status";
    const testBtn = document.createElement("button");
    testBtn.textContent = "测试运行";
    testBtn.addEventListener("click", () => testCli(c, testStatus));
    box.append(
      settingsHead(c.name, (v) => (c.name = v), () => {
        clis.splice(i, 1);
        renderClis();
      }),
      fieldCol("程序名", c.program, (v) => (c.program = v), { placeholder: "claude" }),
      fieldCol("固定参数（指令会作为最后一个参数追加）", c.args, (v) => (c.args = v), { placeholder: "-p" }),
      fieldRow(testBtn, testStatus),
    );
    clisList.appendChild(box);
  });
}

// ---- settings: video sources ----
function renderVideos() {
  videosList.innerHTML = "";
  videos.forEach((v, i) => {
    const box = document.createElement("div");
    box.className = "provider";
    box.append(
      settingsHead(v.name, (s) => (v.name = s), () => {
        videos.splice(i, 1);
        renderVideos();
      }),
      fieldCol("创建任务 Endpoint", v.endpoint, (s) => (v.endpoint = s), {
        placeholder: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      }),
      fieldCol("API Key", v.key, (s) => (v.key = s), { type: "password" }),
      fieldCol("模型（每行一个）", v.models, (s) => (v.models = s), { rows: 2 }),
      fieldRow(
        fieldCol("分辨率", v.resolution, (s) => (v.resolution = s), { placeholder: "1080p", col: true }),
        fieldCol("比例", v.ratio, (s) => (v.ratio = s), { placeholder: "16:9", col: true }),
        fieldCol("时长(秒)", v.duration, (s) => (v.duration = s), { placeholder: "5", col: true }),
      ),
    );
    videosList.appendChild(box);
  });
}

// ---- settings: image sources ----
function renderImages() {
  imagesList.innerHTML = "";
  images.forEach((v, i) => {
    const box = document.createElement("div");
    box.className = "provider";
    box.append(
      settingsHead(v.name, (s) => (v.name = s), () => {
        images.splice(i, 1);
        renderImages();
      }),
      fieldCol("Endpoint（images/generations）", v.endpoint, (s) => (v.endpoint = s), {
        placeholder: "https://ark.cn-beijing.volces.com/api/v3/images/generations",
      }),
      fieldCol("API Key", v.key, (s) => (v.key = s), { type: "password" }),
      fieldCol("模型（每行一个）", v.models, (s) => (v.models = s), { rows: 2 }),
      fieldCol("尺寸", v.size, (s) => (v.size = s), { placeholder: "1024x1024" }),
    );
    imagesList.appendChild(box);
  });
}

// ---- connection tests ----
function testProvider(p: Provider, statusEl: HTMLElement) {
  const model = parseModels(p.models)[0];
  if (!p.endpoint.trim()) return setTest(statusEl, "error", "没填 Endpoint");
  if (!p.key.trim()) return setTest(statusEl, "error", "没填 API Key");
  if (!model) return setTest(statusEl, "error", "没填模型");

  setTest(statusEl, "running", "测试中…");
  let got = false;
  const channel = new Channel<StreamEvent>();
  channel.onmessage = (ev) => {
    if (ev.type === "delta") got = true;
    else if (ev.type === "done")
      setTest(statusEl, "ok", got ? `✓ 通了（${model}）` : "✓ 连上了，但没返回内容");
    else if (ev.type === "error") setTest(statusEl, "error", "✗ " + ev.message.slice(0, 240));
  };
  invoke("chat_stream", {
    url: p.endpoint,
    apiKey: p.key,
    model,
    messages: [{ role: "user", content: "回复两个字：你好" }],
    onEvent: channel,
  }).catch((e) => setTest(statusEl, "error", "✗ " + (e instanceof Error ? e.message : String(e))));
}

function testCli(c: Cli, statusEl: HTMLElement) {
  if (!c.program.trim()) return setTest(statusEl, "error", "没填程序名");
  setTest(statusEl, "running", "运行中…");
  let got = false;
  const channel = new Channel<StreamEvent>();
  channel.onmessage = (ev) => {
    if (ev.type === "delta") got = true;
    else if (ev.type === "done") setTest(statusEl, "ok", got ? "✓ 跑通了" : "✓ 退出正常，无输出");
    else if (ev.type === "error") setTest(statusEl, "error", "✗ " + ev.message.slice(0, 240));
  };
  invoke("cli_run", {
    program: c.program,
    args: parseArgs(c.args),
    prompt: "用一句话回复：你好",
    onEvent: channel,
  }).catch((e) => setTest(statusEl, "error", "✗ " + (e instanceof Error ? e.message : String(e))));
}

function setTest(el: HTMLElement, kind: string, msg: string) {
  el.className = `test-status ${kind}`;
  el.textContent = msg;
}

function openSettings() {
  renderProviders();
  renderClis();
  renderVideos();
  renderImages();
  settingsModal.classList.remove("hidden");
}
function closeSettings() {
  settingsModal.classList.add("hidden");
}

// ---- model market ----
// One market row: name + info lines + an add / 已添加 / 不可用 button. `rows` with empty
// text are skipped, so optional endpoint/models/note all flow through the same builder.
function marketCard(
  container: HTMLElement,
  opts: {
    name: string;
    rows?: { text: string; cls: string }[];
    already: boolean;
    soon?: boolean;
    onAdd?: () => void;
  },
) {
  const item = document.createElement("div");
  item.className = "market-item" + (opts.soon ? " soon" : "");
  const info = document.createElement("div");
  info.className = "market-info";
  const name = document.createElement("div");
  name.className = "market-name";
  name.textContent = opts.name;
  info.appendChild(name);
  for (const r of opts.rows ?? []) {
    if (!r.text) continue;
    const d = document.createElement("div");
    d.className = r.cls;
    d.textContent = r.text;
    info.appendChild(d);
  }
  const add = document.createElement("button");
  add.className = "market-add";
  if (opts.soon) {
    add.textContent = "不可用";
    add.disabled = true;
  } else if (opts.already) {
    add.textContent = "已添加";
    add.disabled = true;
  } else {
    add.textContent = "＋ 添加";
    add.addEventListener("click", () => opts.onAdd?.());
  }
  item.append(info, add);
  container.appendChild(item);
}

function renderMarket() {
  marketList.innerHTML = "";
  for (const preset of PRESETS) {
    marketCard(marketList, {
      name: preset.name,
      rows: [
        { text: preset.endpoint, cls: "market-ep" },
        { text: preset.models ? "模型：" + parseModels(preset.models).join("、") : "", cls: "market-models" },
        { text: preset.note ?? "", cls: "market-note" },
      ],
      already: providers.some((p) => p.name === preset.name),
      soon: preset.soon,
      onAdd: () => {
        providers.push({ name: preset.name, endpoint: preset.endpoint, key: "", models: preset.models });
        saveProviders();
        renderSteps();
        renderMarket();
      },
    });
  }

  marketCliList.innerHTML = "";
  for (const preset of CLI_PRESETS) {
    marketCard(marketCliList, {
      name: preset.name,
      rows: [
        { text: `${preset.program} ${preset.args} <指令>`.trim(), cls: "market-ep" },
        { text: preset.note ?? "", cls: "market-note" },
      ],
      already: clis.some((c) => c.name === preset.name),
      onAdd: () => {
        clis.push({ name: preset.name, program: preset.program, args: preset.args });
        saveClis();
        renderSteps();
        renderMarket();
      },
    });
  }

  marketVideoList.innerHTML = "";
  for (const preset of VIDEO_PRESETS) {
    marketCard(marketVideoList, {
      name: preset.name,
      rows: [
        { text: preset.endpoint, cls: "market-ep" },
        {
          text: `模型：${parseModels(preset.models).join("、")} · ${preset.resolution} ${preset.ratio} ${preset.duration}s`,
          cls: "market-models",
        },
      ],
      already: videos.some((v) => v.name === preset.name),
      onAdd: () => {
        videos.push({ ...preset });
        saveVideos();
        renderSteps();
        renderMarket();
      },
    });
  }

  marketImageList.innerHTML = "";
  for (const preset of IMAGE_PRESETS) {
    marketCard(marketImageList, {
      name: preset.name,
      rows: [
        { text: preset.endpoint, cls: "market-ep" },
        { text: `模型：${parseModels(preset.models).join("、")} · ${preset.size}`, cls: "market-models" },
      ],
      already: images.some((v) => v.name === preset.name),
      onAdd: () => {
        images.push({ ...preset });
        saveImages();
        renderSteps();
        renderMarket();
      },
    });
  }
}

// ---- skills library (SKILL.md in ~/.council/skills) ----
async function refreshSkills() {
  try {
    skills = await invoke<SkillInfo[]>("list_skills");
  } catch {
    skills = [];
  }
  renderSkills();
  refreshGeoSelectors();
  // keep the per-participant / per-agent 技能 dropdowns in sync with the library
  renderRtParticipants();
  renderCodeAgents();
  if (!skillsModal.classList.contains("hidden")) renderSkillsModal();
}

function renderSkills() {
  skillsListEl.innerHTML = "";
  // Drop any checked default-skills that no longer exist.
  defaultSkills = defaultSkills.filter((n) => skills.some((s) => s.name === n));
  if (skills.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-note";
    empty.textContent = "还没有技能。点「＋ 新建」或「⇄ 仓库」下载。";
    skillsListEl.appendChild(empty);
    return;
  }
  const note = document.createElement("div");
  note.className = "sidebar-note";
  note.textContent = "勾选 = 默认技能（协作编程自动带上）。终端里用 ⚡技能 随时调用。✎ 改名，删除在「仓库」。";
  skillsListEl.appendChild(note);

  // Category filter tags (dynamic: 全部 + whatever categories exist + 未分类 if any).
  const cats = ["全部", ...allCategories(), ...(skills.some((s) => !s.category.trim()) ? ["未分类"] : [])];
  if (!cats.includes(sidebarCat)) sidebarCat = "全部";
  const catRow = document.createElement("div");
  catRow.className = "skill-cats";
  for (const c of cats) {
    const chip = document.createElement("button");
    chip.className = "skill-cat-chip" + (c === sidebarCat ? " active" : "");
    chip.textContent = c;
    chip.addEventListener("click", () => {
      sidebarCat = c;
      renderSkills();
    });
    catRow.appendChild(chip);
  }
  skillsListEl.appendChild(catRow);

  const shown = skills.filter((s) => sidebarCat === "全部" || (s.category.trim() || "未分类") === sidebarCat);
  for (const s of shown) {
    const item = document.createElement("div");
    item.className = "skill-item";

    const row = document.createElement("div");
    row.className = "skill-row";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "skill-check";
    cb.checked = defaultSkills.includes(s.name);
    cb.title = "勾选 = 默认技能";
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => {
      if (cb.checked) {
        if (!defaultSkills.includes(s.name)) defaultSkills.push(s.name);
      } else {
        defaultSkills = defaultSkills.filter((n) => n !== s.name);
      }
      saveDefaultSkills();
    });

    const txt = document.createElement("div");
    txt.className = "skill-text";
    const name = document.createElement("div");
    name.className = "skill-name";
    name.textContent = s.name;
    const desc = document.createElement("div");
    desc.className = "skill-desc";
    desc.textContent = s.description || "（无描述）";
    txt.append(name, desc);
    txt.addEventListener("click", () => openSkillEditor(s.name));

    const edit = document.createElement("button");
    edit.className = "skill-edit mini";
    edit.textContent = "✎";
    edit.title = "编辑这条技能";
    edit.addEventListener("click", (e) => {
      e.stopPropagation();
      openSkillEditor(s.name);
    });

    row.append(cb, txt, edit);
    item.append(row);
    skillsListEl.appendChild(item);
  }
}

let editingSkill: string | null = null; // null = new
let resetSkillDel: () => void = () => {}; // resets the modal 删除 button's armed state
async function openSkillEditor(name: string | null) {
  resetSkillDel();
  editingSkill = name;
  $("#skill-modal-title").textContent = name ? "编辑技能" : "新建技能";
  const nameEl = $<HTMLInputElement>("#skill-name");
  const descEl = $<HTMLInputElement>("#skill-desc");
  const catEl = $<HTMLInputElement>("#skill-category");
  const bodyEl = $<HTMLTextAreaElement>("#skill-body");
  const delBtn = $<HTMLButtonElement>("#skill-delete");
  // Category suggestions (used + user-created); typing a new one also creates that category.
  $<HTMLDataListElement>("#skill-cat-list").innerHTML = allCategories()
    .map((c) => `<option value="${escHtml(c)}"></option>`)
    .join("");
  nameEl.value = name ?? "";
  descEl.value = "";
  catEl.value = "";
  bodyEl.value = "";
  delBtn.classList.toggle("hidden", !name);
  if (name) {
    try {
      const content = await invoke<string>("read_skill", { name });
      const m = content.match(/^description:\s*(.*)$/m);
      descEl.value = m ? m[1].trim() : "";
      const cm = content.match(/^category:\s*(.*)$/m);
      catEl.value = cm ? cm[1].trim() : "";
      bodyEl.value = skillBody(content);
    } catch {
      /* ignore */
    }
  }
  skillModal.classList.remove("hidden");
}

async function saveSkill() {
  const name = $<HTMLInputElement>("#skill-name").value.trim();
  const description = $<HTMLInputElement>("#skill-desc").value;
  const category = $<HTMLInputElement>("#skill-category").value.trim();
  const body = $<HTMLTextAreaElement>("#skill-body").value;
  if (!name) return toast("技能要有名字");
  try {
    await invoke("save_skill", { name, description, category, body });
    // renamed during edit → remove the old folder
    if (editingSkill && editingSkill !== name) {
      await invoke("delete_skill", { name: editingSkill });
    }
    skillModal.classList.add("hidden");
    await refreshSkills();
    renderSteps();
  } catch (e) {
    toast("保存失败：" + (e instanceof Error ? e.message : String(e)));
  }
}

// Two-step delete on a button: first click arms (turns red), second click within 2.5s
// confirms. Avoids native confirm(), which is unreliable inside the Tauri webview.
function twoStepDelete(
  btn: HTMLButtonElement,
  restoreLabel: string,
  armedLabel: string,
  onConfirm: () => void,
): () => void {
  let armed = false;
  let timer: number | undefined;
  const reset = () => {
    armed = false;
    if (timer) clearTimeout(timer);
    btn.textContent = restoreLabel;
    btn.classList.remove("armed");
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!armed) {
      armed = true;
      btn.textContent = armedLabel;
      btn.classList.add("armed");
      timer = window.setTimeout(reset, 2500);
    } else {
      reset();
      onConfirm();
    }
  });
  return reset;
}

async function doDeleteSkill(name: string) {
  try {
    await invoke("delete_skill", { name });
    if (geo.skill === name) {
      geo.skill = ""; // was selected for 单篇 — clear it
      saveGeo();
    }
    let changedSteps = false;
    for (const step of steps) {
      if (step.skill === name) {
        step.skill = undefined;
        changedSteps = true;
      }
    }
    if (changedSteps) saveSteps();
    await refreshSkills();
    renderSteps();
  } catch (e) {
    toast("删除失败：" + (e instanceof Error ? e.message : String(e)));
  }
}

// ---- skills repo sync ----
function streamToOutput(command: string, payload: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const channel = new Channel<StreamEvent>();
    channel.onmessage = (ev) => {
      if (ev.type === "delta") {
        syncOutput.textContent += ev.text;
        syncOutput.scrollTop = syncOutput.scrollHeight;
      } else if (ev.type === "done") {
        syncOutput.textContent += "\n✓ 完成\n";
        resolve();
      } else if (ev.type === "error") {
        syncOutput.textContent += "\n✗ " + ev.message + "\n";
        reject(new Error(ev.message));
      }
    };
    invoke(command, { ...payload, onEvent: channel }).catch(reject);
  });
}

// Disable the repo buttons while a git op runs so the modal clearly looks "busy",
// not frozen, and can't be double-fired.
function setSyncBusy(busy: boolean) {
  for (const id of ["#sync-dl-btn", "#sync-up-btn", "#sync-import-file", "#sync-import-dir"]) {
    $<HTMLButtonElement>(id).disabled = busy;
  }
}

async function downloadSkills() {
  const url = $<HTMLInputElement>("#sync-dl-url").value.trim();
  if (!url) return toast("填一个仓库 URL");
  syncOutput.textContent = "克隆中…（最多约 45 秒，认证卡住会自动超时）\n";
  setSyncBusy(true);
  try {
    await streamToOutput("skills_download", { url });
    await refreshSkills();
    renderSteps();
  } catch {
    /* error already shown in output */
  } finally {
    setSyncBusy(false);
  }
}

async function uploadSkills() {
  const url = $<HTMLInputElement>("#sync-up-url").value.trim();
  const message = $<HTMLInputElement>("#sync-up-msg").value;
  if (!url) return toast("填上传目标仓库 URL");
  syncOutput.textContent = "上传中…（最多约 45 秒，认证卡住会自动超时）\n";
  setSyncBusy(true);
  try {
    await streamToOutput("skills_upload", { url, message });
  } catch {
    /* error already shown in output */
  } finally {
    setSyncBusy(false);
  }
}

// Import skills straight from local files: a picked SKILL.md (or several), or a folder
// whose subfolders each hold a SKILL.md. Reads the text and copies into the skill library.
async function importLocalSkills(fileList: FileList | null) {
  if (!fileList || !fileList.length) return;
  const all = Array.from(fileList).filter((f) => /\.(md|markdown)$/i.test(f.name));
  // From a folder pick we only want the SKILL.md files; from a file pick, take whatever .md was chosen.
  const skillMds = all.filter((f) => f.name.toLowerCase() === "skill.md");
  const list = skillMds.length ? skillMds : all;
  syncOutput.textContent = "";
  if (!list.length) {
    syncOutput.textContent = "没找到 .md / SKILL.md 文件\n";
    return;
  }
  let ok = 0;
  for (const f of list) {
    try {
      const text = await f.text();
      const nameM = text.match(/^name:\s*(.*)$/m);
      const descM = text.match(/^description:\s*(.*)$/m);
      const catM = text.match(/^category:\s*(.*)$/m);
      let name = nameM ? nameM[1].trim() : "";
      if (!name) {
        // Fall back to the containing folder name (folder pick) or the file stem.
        const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || "";
        const parts = rel.split("/").filter(Boolean);
        name = parts.length >= 2 ? parts[parts.length - 2] : f.name.replace(/\.(md|markdown)$/i, "");
      }
      await invoke("save_skill", {
        name,
        description: descM ? descM[1].trim() : "",
        category: catM ? catM[1].trim() : "",
        body: skillBody(text),
      });
      syncOutput.textContent += `✓ ${name}\n`;
      ok++;
    } catch (e) {
      syncOutput.textContent += `✗ ${f.name}：${e instanceof Error ? e.message : String(e)}\n`;
    }
  }
  syncOutput.textContent += `\n导入完成：成功 ${ok} / ${list.length}\n`;
  await refreshSkills();
  renderSteps();
}

// ---- workflow library (files in ~/.council/workflows) ----
async function refreshWorkflowList() {
  let names: string[] = [];
  try {
    names = await invoke<string[]>("list_workflows");
  } catch {
    names = [];
  }
  fillSelect(wfLoadEl, names.map((n) => ({ value: n, label: n })), "", { none: "载入已存…" });
}

async function saveWorkflow() {
  const name = wfNameEl.value.trim();
  if (!name) {
    toast("先给工作流起个名");
    return;
  }
  const content = JSON.stringify({ input: inputEl.value, steps }, null, 2);
  try {
    const path = await invoke<string>("save_workflow", { name, content });
    await refreshWorkflowList();
    wfLoadEl.value = name;
    flash(`已保存到 ${path}`);
  } catch (e) {
    toast("保存失败：" + (e instanceof Error ? e.message : String(e)));
  }
}

async function loadWorkflow(name: string) {
  try {
    const content = await invoke<string>("load_workflow", { name });
    const data = JSON.parse(content) as { input?: string; steps?: Step[] };
    inputEl.value = data.input ?? "";
    localStorage.setItem(LS_INPUT, inputEl.value);
    steps = Array.isArray(data.steps) ? data.steps : [];
    saveSteps();
    wfNameEl.value = name;
    renderSteps();
  } catch (e) {
    toast("载入失败：" + (e instanceof Error ? e.message : String(e)));
  }
}

async function deleteWorkflow() {
  const name = wfNameEl.value.trim();
  if (!name) return toast("先选中一个工作流");
  try {
    await invoke("delete_workflow", { name });
    await refreshWorkflowList();
    wfNameEl.value = "";
    wfLoadEl.value = "";
    flash(`已删除「${name}」`);
  } catch (e) {
    toast("删除失败：" + (e instanceof Error ? e.message : String(e)));
  }
}

// brief transient message in the toolbar tagline
function flash(msg: string) {
  const el = document.querySelector(".tagline") as HTMLElement;
  const prev = el.textContent;
  el.textContent = msg;
  setTimeout(() => (el.textContent = prev), 2200);
}

// ---- GEO 单篇 mode ----
const geoEditor = $<HTMLElement>("#geo-editor");
const pipeEditor = $<HTMLElement>("#pipe-editor");
const wfbar = document.querySelector(".wfbar") as HTMLElement;

function renderGeoStyles() {
  const wrap = $<HTMLDivElement>("#geo-styles");
  wrap.innerHTML = "";
  for (const s of GEO_STYLES) {
    const b = document.createElement("button");
    b.className = "geo-style-btn" + (s.key === geo.style ? " active" : "");
    b.textContent = s.label;
    b.title = s.hint;
    b.addEventListener("click", () => {
      geo.style = s.key;
      saveGeo();
      renderGeoStyles();
    });
    wrap.appendChild(b);
  }
}

function renderGeoParams() {
  const wrap = $<HTMLDivElement>("#geo-params");
  wrap.innerHTML = "";
  geo.params.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "geo-param-row";
    const k = document.createElement("input");
    k.placeholder = "键，如 天气";
    k.value = p.k;
    k.addEventListener("input", () => {
      p.k = k.value;
      saveGeo();
    });
    const v = document.createElement("input");
    v.placeholder = "值，如 晴";
    v.value = p.v;
    v.addEventListener("input", () => {
      p.v = v.value;
      saveGeo();
    });
    const del = document.createElement("button");
    del.className = "danger mini";
    del.textContent = "✕";
    del.addEventListener("click", () => {
      geo.params.splice(i, 1);
      saveGeo();
      renderGeoParams();
    });
    row.append(k, v, del);
    wrap.appendChild(row);
  });
}

let dragIdx: number | null = null;
function renderGeoCards() {
  const wrap = $<HTMLDivElement>("#geo-cards");
  wrap.innerHTML = "";
  geo.cards.forEach((c, i) => {
    const card = document.createElement("div");
    card.className = "geo-card";
    card.draggable = true;
    card.addEventListener("dragstart", () => {
      dragIdx = i;
    });
    card.addEventListener("dragover", (e) => e.preventDefault());
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      if (dragIdx === null || dragIdx === i) return;
      const [m] = geo.cards.splice(dragIdx, 1);
      geo.cards.splice(i, 0, m);
      dragIdx = null;
      saveGeo();
      renderGeoCards();
    });

    const head = document.createElement("div");
    head.className = "geo-card-head";
    const handle = document.createElement("span");
    handle.className = "geo-handle";
    handle.textContent = "⠿";
    const num = document.createElement("span");
    num.className = "geo-card-num";
    num.textContent = `第 ${i + 1} 站`;
    const del = document.createElement("button");
    del.className = "danger mini";
    del.textContent = "✕";
    del.addEventListener("click", () => {
      geo.cards.splice(i, 1);
      saveGeo();
      renderGeoCards();
    });
    head.append(handle, num, del);

    const place = document.createElement("input");
    place.placeholder = "地名，如 法喜寺";
    place.value = c.place;
    place.addEventListener("input", () => {
      c.place = place.value;
      saveGeo();
    });
    const note = document.createElement("textarea");
    note.rows = 2;
    note.placeholder = "随手记的素材：斋饭好吃，5 月玉兰花开，人多但清静";
    note.value = c.note;
    note.addEventListener("input", () => {
      c.note = note.value;
      saveGeo();
    });

    card.append(head, place, note);
    wrap.appendChild(card);
  });
}

// Rebuild the GEO model/skill selects from current providers + skills, keeping the selection.
function refreshGeoSelectors() {
  const ws = $<HTMLSelectElement>("#geo-worker");
  if (!ws) return;
  let changed = false;
  const opts = workerOptions().filter((o) => !o.value.startsWith("vid::"));
  if (geo.worker && !opts.some((o) => o.value === geo.worker)) {
    geo.worker = "";
    changed = true;
  }
  if (!geo.worker) {
    geo.worker = opts[0]?.value ?? "";
    changed = true;
  }
  fillSelect(ws, opts, geo.worker);

  const sk = $<HTMLSelectElement>("#geo-skill");
  if (geo.skill && !skills.some((s) => s.name === geo.skill)) {
    geo.skill = "";
    changed = true;
  }
  fillSelect(sk, skills.map((s) => ({ value: s.name, label: s.name })), geo.skill, {
    none: "（用内置 GEO 规范）",
  });

  // 配图来源: local CLIs (→ SVG) + HTTP image providers (→ real image)
  const im = $<HTMLSelectElement>("#geo-image");
  const imgOpts: { value: string; label: string }[] = [];
  for (const c of clis) imgOpts.push({ value: `cli::${c.name}`, label: `SVG · ${c.name}` });
  for (const p of images) {
    for (const m of parseModels(p.models)) {
      imgOpts.push({ value: `img::${p.name}::${m}`, label: `🖼 ${p.name} · ${m}` });
    }
  }
  if (geo.image && !imgOpts.some((o) => o.value === geo.image)) {
    geo.image = "";
    changed = true;
  }
  fillSelect(im, imgOpts, geo.image, { none: "（不配图）" });
  if (changed) saveGeo();
}

function renderGeo() {
  $<HTMLInputElement>("#geo-title").value = geo.title;
  $<HTMLTextAreaElement>("#geo-material").value = geo.material;
  $<HTMLInputElement>("#geo-source").value = geo.source;
  $<HTMLTextAreaElement>("#geo-route").value = geo.route;
  $<HTMLInputElement>("#geo-length").value = String(geo.length);
  $("#geo-len-val").textContent = String(geo.length);
  renderGeoStyles();
  renderGeoParams();
  renderGeoCards();
  refreshGeoSelectors();
}

// Assemble the user-facing brief from the form.
function buildGeoBrief(): string {
  const lines: string[] = [];
  if (geo.title.trim()) lines.push(`标题：${geo.title.trim()}`);
  const style = GEO_STYLES.find((s) => s.key === geo.style) ?? GEO_STYLES[0];
  lines.push(`风格：${style.label}（${style.hint}）`);
  lines.push(`目标篇幅：约 ${geo.length} 字`);
  if (geo.length < 320) {
    lines.push(
      "这是篇短文：精简结构，用一个标题、不分或少分小标题、省略「常见问题」，几段话把核心说清即可；每段仍要自足、可单独读懂。",
    );
  }
  if (geo.material.trim()) {
    lines.push(
      `原文 / 素材（基于它改写成上面要求的文章，保留事实信息、重组结构换表达、按 GEO 规则成文，不要逐句照抄）：\n"""\n${geo.material.trim()}\n"""`,
    );
  }
  if (geo.route.trim()) lines.push(`路线 / 地点：${geo.route.trim()}`);
  const params = geo.params.filter((p) => p.k.trim() || p.v.trim());
  if (params.length) {
    lines.push("其他参数：");
    for (const p of params) lines.push(`- ${p.k.trim() || "（未命名）"}：${p.v.trim()}`);
  }
  const cards = geo.cards.filter((c) => c.place.trim() || c.note.trim());
  if (cards.length) {
    lines.push("地点素材（按此顺序成章）：");
    cards.forEach((c, i) =>
      lines.push(`${i + 1}. ${c.place.trim() || "（未命名地点）"}${c.note.trim() ? ` —— ${c.note.trim()}` : ""}`),
    );
  }
  return lines.join("\n");
}

// cnLen now imported from ./utils (pure + tested)

// splitGeo now imported from ./utils (pure + tested)

function makeGeoResultCard(title: string) {
  const copy = document.createElement("button");
  copy.className = "result-copy mini";
  copy.textContent = "复制";
  const { body, setStatus } = cardShell(title, { extras: [copy] });

  let getText = () => body.textContent ?? "";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(getText());
      copy.textContent = "已复制";
      setTimeout(() => (copy.textContent = "复制"), 1200);
    } catch {
      /* clipboard blocked */
    }
  });

  const textFlush = makeTextFlusher(body);

  return {
    streamText: (s: string) => {
      textFlush.stream(s);
    },
    // Replace streamed text with an editable textarea once generation finishes.
    setEditable: (s: string) => {
      textFlush.cancel();
      body.innerHTML = "";
      const ta = document.createElement("textarea");
      ta.className = "result-edit";
      ta.value = s;
      ta.rows = Math.min(34, Math.max(6, s.split("\n").length + 1));
      body.appendChild(ta);
      getText = () => ta.value;
    },
    setError: (s: string) => {
      textFlush.cancel();
      body.classList.add("error");
      body.textContent = s;
    },
    setStatus,
    // Current text (edited value once setEditable ran, else streamed text).
    getText: () => getText(),
  };
}

// Stream one worker call into its own editable result card. `run(onDelta)` performs the
// actual call. Returns the finished text + a live getText (for export/history), or null
// if it errored / was stopped. genId-aware. Used by 圆桌 and 协作编程.
async function streamCard(
  my: number,
  title: string,
  verb: string,
  run: (onDelta: (t: string) => void) => Promise<void>,
  skippable = false,
): Promise<{ text: string; getText: () => string } | null> {
  const card = makeGeoResultCard(title);
  // Headless CLIs (e.g. claude -p) often print nothing until they finish, so a tick of
  // elapsed seconds makes clear the agent is alive and working, not stuck.
  const t0 = Date.now();
  let acc = "";
  const status = () => {
    const s = Math.round((Date.now() - t0) / 1000);
    card.setStatus("running", acc ? `${verb}… 约 ${cnLen(acc)} 字 · ${s}s` : `${verb}… ${s}s`);
  };
  status();
  card.streamText("⏳ 运行中…（headless CLI 如 claude -p 多在跑完后才一次性输出）");
  const timer = window.setInterval(status, 1000);
  try {
    await run((t) => {
      if (!acc) card.streamText(""); // clear the waiting hint on first real output
      acc += t;
      card.streamText(acc);
      status();
      scheduleScroll();
    });
  } catch (e) {
    clearInterval(timer);
    if (my !== genId) return null;
    card.setError(
      "出错：" + (e instanceof Error ? e.message : String(e)) + (skippable ? "\n\n（已跳过这一位，继续下一位）" : ""),
    );
    card.setStatus("error", skippable ? "出错 · 跳过" : "出错");
    return null;
  }
  clearInterval(timer);
  if (my !== genId) return null;
  const text = acc.trim();
  card.setEditable(text);
  card.setStatus("done", `${cnLen(text)} 字`);
  return { text, getText: card.getText };
}

// extractSvg / sanitizeSvg now imported from ./utils (pure + tested)

type ImgResult = { kind: "svg" | "url" | "err"; data: string };
async function generateImage(desc: string): Promise<ImgResult> {
  const w = geo.image;
  if (w.startsWith("cli::")) {
    const name = w.slice(5);
    if (!clis.some((c) => c.name === name)) return { kind: "err", data: `找不到命令：${name}` };
    const prompt = `请为文章画一张配图，主题：${desc}。\n直接把一段完整 SVG 代码打印到标准输出：以 <svg 开头、以 </svg> 结尾，带 viewBox、宽约 800。画面简洁、有信息量，可含图形与少量文字标注。\n不要创建或修改任何文件、不要运行其他命令、不要任何解释、不要 markdown 代码块围栏，只输出 SVG 本身。`;
    let acc = "";
    await runWorker(w, "", prompt, (t) => (acc += t), () => {});
    const svg = extractSvg(acc);
    return svg
      ? { kind: "svg", data: svg }
      : { kind: "err", data: `CLI 没产出 SVG（输出开头：${acc.slice(0, 120)}…）` };
  }
  if (w.startsWith("img::")) {
    const parts = w.split("::");
    const provider = parts[1] ?? "";
    const model = parts.slice(2).join("::");
    const p = images.find((x) => x.name === provider);
    if (!p) return { kind: "err", data: `找不到图片源：${provider}` };
    if (!p.endpoint.trim() || !p.key.trim())
      return { kind: "err", data: `图片源「${p.name}」缺 Endpoint 或 Key` };
    const url = await invoke<string>("image_generate", {
      endpoint: p.endpoint,
      apiKey: p.key,
      model,
      prompt: desc,
      size: p.size || "",
    });
    return { kind: "url", data: url };
  }
  return { kind: "err", data: "未选配图来源" };
}

// One image slot in the gallery: shows 生成中 / image / error+retry, independently.
interface ImgSlot {
  pending: () => void;
  fill: (r: ImgResult, onRetry: () => void) => void;
}
function makeImageGallery() {
  const { body, setStatus } = cardShell("配图");
  return {
    addSlot: (n: number, desc: string): ImgSlot => {
      const fig = document.createElement("figure");
      fig.className = "geo-figure";
      const holder = document.createElement("div");
      const cap = document.createElement("figcaption");
      cap.className = "geo-cap";
      cap.textContent = `配图 ${n}：${desc}`;
      fig.append(holder, cap);
      body.appendChild(fig);

      const pending = () => {
        holder.className = "geo-cap";
        holder.textContent = `配图 ${n} 生成中…`;
      };
      pending();
      const fill = (r: ImgResult, onRetry: () => void) => {
        holder.className = "";
        holder.innerHTML = "";
        if (r.kind === "svg") {
          const box = document.createElement("div");
          box.className = "geo-svg";
          box.innerHTML = sanitizeSvg(r.data);
          holder.appendChild(box);
        } else if (r.kind === "url") {
          const img = document.createElement("img");
          img.className = "geo-img";
          img.src = r.data;
          img.loading = "lazy";
          const link = document.createElement("a");
          link.className = "result-link";
          link.href = r.data;
          link.target = "_blank";
          link.textContent = "图片链接（记得及时下载）";
          holder.append(img, link);
        } else {
          const er = document.createElement("div");
          er.className = "result-body error";
          er.textContent = `配图 ${n} 失败：${r.data}`;
          const retry = document.createElement("button");
          retry.className = "mini";
          retry.textContent = "重试这张";
          retry.style.marginTop = "6px";
          retry.addEventListener("click", () => {
            pending();
            onRetry();
          });
          holder.append(er, retry);
        }
        scheduleScroll();
      };
      return { pending, fill };
    },
    setStatus,
  };
}

// Top-of-results export bar (prepended above all result cards): 复制全文 / 导出 .md /
// 导出 .txt. Builders are read lazily on click, so they capture the latest edited text.
function makeExportToolbar(
  cardTitle: string,
  fileHint: string,
  buildMarkdown: () => string,
  buildText: () => string,
) {
  const copy = document.createElement("button");
  copy.className = "mini";
  copy.textContent = "复制全文";
  const md = document.createElement("button");
  md.className = "mini primary";
  md.textContent = "导出 .md";
  const txt = document.createElement("button");
  txt.className = "mini";
  txt.textContent = "导出 .txt";
  const { setStatus } = cardShell(cardTitle, { extras: [copy, md, txt], prepend: true, body: false });

  const download = (text: string, ext: string, mime: string) => {
    const safe = (fileHint || "council").replace(/[\/\\:*?"<>|]+/g, "").slice(0, 40).trim() || "council";
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safe}${ext}`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus("done", "已导出");
    setTimeout(() => setStatus("done", ""), 1500);
  };

  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(buildMarkdown());
      copy.textContent = "已复制";
      setTimeout(() => (copy.textContent = "复制全文"), 1200);
    } catch {
      /* clipboard blocked */
    }
  });
  md.addEventListener("click", () => download(buildMarkdown(), ".md", "text/markdown;charset=utf-8"));
  txt.addEventListener("click", () => download(buildText(), ".txt", "text/plain;charset=utf-8"));
}

async function runGeo() {
  if (running) return;
  if (!geo.worker) {
    toast("先选个模型（没有就去「模型市场」加一个）");
    return;
  }
  const hasContent =
    geo.title.trim() ||
    geo.material.trim() ||
    geo.source.trim() ||
    geo.route.trim() ||
    geo.cards.some((c) => c.place.trim() || c.note.trim());
  if (!hasContent) {
    toast("至少填个标题、原文素材、链接，或路线/地点");
    return;
  }

  const my = beginRun();

  let card: ReturnType<typeof makeGeoResultCard> | null = null;
  try {
    let skillText = "";
    if (geo.skill) {
      try {
        skillText = skillBody(await invoke<string>("read_skill", { name: geo.skill }));
      } catch {
        skillText = "";
      }
    }
    if (my !== genId) return;

    // GEO structure always applies; an attached skill layers on top as extra guidance.
    const sysParts = [GEO_BODY];
    if (skillText.trim()) sysParts.push(`附加技能规范：\n${skillText.trim()}`);
    if (geo.image) sysParts.push(GEO_IMG_CONTRACT);
    sysParts.push(GEO_CONTRACT);
    const system = sysParts.join("\n\n");

    card = makeGeoResultCard("正文（GEO 结构）");
    card.setStatus("running", geo.source.trim() ? "读取链接中…" : "生成中…");

    // If a source URL was given, fetch its text and rewrite from it.
    let brief = buildGeoBrief();
    if (geo.source.trim()) {
      try {
        const fetched = await invoke<string>("fetch_url", { url: geo.source.trim() });
        if (my !== genId) return;
        brief += `\n\n以下是参考链接的正文内容，请基于它改写成上面要求的文章（保留事实信息，重组结构、换表达、按 GEO 规则成文，不要逐句照抄）：\n"""\n${fetched.slice(0, 12000)}\n"""`;
        card.setStatus("running", "生成中…");
      } catch (e) {
        if (my !== genId) return;
        card.setError("读取链接失败：" + (e instanceof Error ? e.message : String(e)));
        card.setStatus("error", "出错");
        return;
      }
    }

    let acc = "";
    await runWorker(
      geo.worker,
      system,
      brief,
      (text) => {
        acc += text;
        card!.streamText(acc);
        card!.setStatus("running", `生成中… 约 ${cnLen(acc)} 字`);
        scheduleScroll();
      },
      () => {
        /* video events don't apply here */
      },
    );
    if (my !== genId) return;

    const { article, tweet } = splitGeo(acc);

    // Pull out [[IMG: ...]] markers (tolerate full-width colon / spacing / case) and
    // replace each with a clean 〔配图N〕 placeholder so the article reads cleanly; the
    // images render below in matching order.
    const markers: string[] = [];
    const cleaned = geo.image
      ? article.replace(/\[\[\s*IMG\s*[:：]\s*([^\]]+?)\]\]/gi, (_m, desc) => {
          markers.push(String(desc).trim());
          return `〔配图${markers.length}〕`;
        })
      : article;

    card.setEditable(cleaned);
    card.setStatus("done", `完成 · 约 ${cnLen(cleaned)} 字（目标 ${geo.length}）`);
    let tweetCard: ReturnType<typeof makeGeoResultCard> | null = null;
    if (tweet) {
      tweetCard = makeGeoResultCard("小推文");
      tweetCard.setEditable(tweet);
      tweetCard.setStatus("done", `${cnLen(tweet)} 字`);
    }

    // Export bundles the (possibly edited) article, generated images and tweet into one .md.
    const imgResults: (ImgResult | null)[] = markers.map(() => null);
    const buildMarkdown = () => {
      let md = card!
        .getText()
        .replace(/〔配图(\d+)〕/g, (_m, ns: string) => {
          const i = parseInt(ns, 10) - 1;
          const r = imgResults[i];
          const desc = markers[i] ?? "";
          if (!r || r.kind === "err") return `〔配图${ns}〕`;
          if (r.kind === "url") return `\n\n![配图${ns}：${desc}](${r.data})\n`;
          return `\n\n${sanitizeSvg(r.data)}\n`; // raw SVG (markdown allows inline HTML)
        })
        .trim();
      const tw = tweetCard ? tweetCard.getText().trim() : "";
      if (tw) md += `\n\n---\n\n**小推文**\n\n${tw}\n`;
      return md + "\n";
    };
    // Plain text: keep image markers as readable placeholders (no URLs / SVG), tweet plain.
    const buildText = () => {
      let t = card!
        .getText()
        .replace(/〔配图(\d+)〕/g, (_m, ns: string) => `[配图${ns}：${markers[parseInt(ns, 10) - 1] ?? ""}]`)
        .trim();
      const tw = tweetCard ? tweetCard.getText().trim() : "";
      if (tw) t += `\n\n———\n小推文\n\n${tw}\n`;
      return t + "\n";
    };
    const titleHint = geo.title.trim() || article.split("\n")[0].replace(/^#+\s*/, "").trim();
    makeExportToolbar("整篇", titleHint, buildMarkdown, buildText);
    pushHistory("geo", titleHint, buildMarkdown());

    // Generate an image per marker: HTTP image sources in parallel, local CLI serially
    // (CLI spawns a local process each time). Each slot can be retried on its own.
    if (geo.image && markers.length) {
      const gal = makeImageGallery();
      const slots = markers.map((d, i) => gal.addSlot(i + 1, d));
      const genInto = async (i: number) => {
        let r: ImgResult;
        try {
          r = await generateImage(markers[i]);
        } catch (e) {
          r = { kind: "err", data: e instanceof Error ? e.message : String(e) };
        }
        imgResults[i] = r;
        slots[i].fill(r, () => {
          imgResults[i] = null;
          void genInto(i);
        });
      };
      if (geo.image.startsWith("img::")) {
        gal.setStatus("running", `并行生成 ${markers.length} 张配图…`);
        await Promise.all(markers.map((_, i) => genInto(i)));
      } else {
        for (let i = 0; i < markers.length; i++) {
          if (my !== genId) return;
          gal.setStatus("running", `配图 ${i + 1}/${markers.length}…`);
          await genInto(i);
        }
      }
      if (my !== genId) return;
      gal.setStatus("done", "配图完成");
    }
  } catch (e) {
    if (my === genId && card) {
      card.setError(e instanceof Error ? e.message : String(e));
      card.setStatus("error", "出错");
    }
  } finally {
    endRun(my);
  }
}

// ---- 圆桌 mode ----
const rtEditor = $<HTMLElement>("#rt-editor");

// Workers usable in 圆桌 / 单篇: HTTP + CLI, but not video.
function chatWorkerOptions() {
  return workerOptions().filter((o) => !o.value.startsWith("vid::"));
}
function codingAgentOptions(): { value: string; label: string }[] {
  const opts = CODING_CLIS.map((c) => ({ value: c.program, label: c.label }));
  for (const c of clis) {
    if (!CODING_CLIS.some((k) => k.program === c.program)) {
      opts.push({ value: `cli::${c.name}`, label: `CLI · ${c.name}` });
    }
  }
  return opts;
}
// Resolve an agent's worker value to the program to launch (bare name, or a configured CLI).
function codingProgram(worker: string): string {
  if (worker.startsWith("cli::")) return clis.find((c) => `cli::${c.name}` === worker)?.program ?? "";
  return worker;
}

// Each round-table participant is a card: a model select + its own skill select (so
// different models can play different roles), draggable to set the relay order.
let rtDragIdx: number | null = null;
function renderRtParticipants() {
  const wrap = $<HTMLDivElement>("#rt-participants");
  wrap.innerHTML = "";
  const opts = chatWorkerOptions();
  if (!rt.participants.length) {
    const note = document.createElement("div");
    note.className = "sidebar-note";
    note.textContent =
      "还没有参与模型。点「＋ 加一位」，至少加 2 个（最好不同厂商）才有讨论的意义；可给每位单独挂技能，扮演不同角色。";
    wrap.appendChild(note);
  }
  rt.participants.forEach((p, i) => {
    const cardEl = document.createElement("div");
    cardEl.className = "code-agent";
    cardEl.draggable = true;
    cardEl.addEventListener("dragstart", () => (rtDragIdx = i));
    cardEl.addEventListener("dragover", (e) => e.preventDefault());
    cardEl.addEventListener("drop", (e) => {
      e.preventDefault();
      if (rtDragIdx === null || rtDragIdx === i) return;
      const [m] = rt.participants.splice(rtDragIdx, 1);
      rt.participants.splice(i, 0, m);
      rtDragIdx = null;
      saveRt();
      renderRtParticipants();
    });

    const head = document.createElement("div");
    head.className = "code-agent-head";
    const handle = document.createElement("span");
    handle.className = "geo-handle";
    handle.textContent = "⠿";
    const num = document.createElement("span");
    num.className = "rt-num";
    num.textContent = `${i + 1}.`;

    const wsel = document.createElement("select");
    const list =
      p.worker && !opts.some((o) => o.value === p.worker)
        ? [...opts, { value: p.worker, label: `（已失效）${workerLabel(p.worker)}` }]
        : opts;
    fillSelect(wsel, list, p.worker);
    wsel.addEventListener("change", () => {
      p.worker = wsel.value;
      saveRt();
    });

    const del = document.createElement("button");
    del.className = "danger mini";
    del.textContent = "✕";
    del.addEventListener("click", () => {
      rt.participants.splice(i, 1);
      saveRt();
      renderRtParticipants();
    });
    head.append(handle, num, wsel, del);

    const skillRow = document.createElement("div");
    skillRow.className = "rt-skill";
    const lab = document.createElement("span");
    lab.className = "wfbar-label";
    lab.textContent = "技能";
    const ssel = document.createElement("select");
    if (p.skill && !skills.some((s) => s.name === p.skill)) p.skill = ""; // skill was deleted → clear
    fillSelect(ssel, skills.map((s) => ({ value: s.name, label: s.name })), p.skill, { none: "（不挂技能）" });
    ssel.addEventListener("change", () => {
      p.skill = ssel.value;
      saveRt();
    });
    skillRow.append(lab, ssel);

    cardEl.append(head, skillRow);
    wrap.appendChild(cardEl);
  });
}

function refreshRtSelectors() {
  const md = $<HTMLSelectElement>("#rt-moderator");
  if (!md) return;
  let changed = false;
  const opts = chatWorkerOptions();
  if (rt.moderator && !opts.some((o) => o.value === rt.moderator)) {
    rt.moderator = "";
    changed = true;
  }
  if (!rt.moderator) {
    rt.moderator = opts[0]?.value ?? "";
    changed = true;
  }
  fillSelect(md, opts, rt.moderator);
  if (changed) saveRt();
}

function renderRt() {
  $<HTMLTextAreaElement>("#rt-question").value = rt.question;
  $<HTMLInputElement>("#rt-role").value = rt.role;
  $<HTMLInputElement>("#rt-rounds").value = String(rt.rounds);
  $("#rt-rounds-val").textContent = String(rt.rounds);
  renderRtParticipants();
  refreshRtSelectors();
}

async function runRoundtable() {
  if (running) return;
  if (!rt.question.trim()) return toast("先填讨论的问题");
  const valid = new Set(chatWorkerOptions().map((o) => o.value));
  const parts = rt.participants.filter((p) => valid.has(p.worker));
  if (parts.length < 2) return toast("至少选 2 个有效的参与模型");
  if (!rt.moderator || !valid.has(rt.moderator)) return toast("先选一个有效的主持人（综述用）");

  const my = beginRun();
  try {
    const Q = rt.question.trim();
    const baseSys = rt.role.trim() || "你在参加一个多模型接力讨论，目标是把这个问题的答案打磨到最好。";
    const transcript: { label: string; round: number; text: string }[] = [];
    // Cards in display order, read lazily at export time so edits are captured.
    const exportEntries: { heading: string; getText: () => string }[] = [];
    let draft = "";

    // Preload each attached skill's body once (its text layers onto that one's system prompt).
    const bodies: Record<string, string> = {};
    for (const p of parts) {
      if (p.skill && !(p.skill in bodies)) {
        try {
          bodies[p.skill] = skillBody(await invoke<string>("read_skill", { name: p.skill }));
        } catch {
          bodies[p.skill] = "";
        }
      }
    }
    if (my !== genId) return;

    const contribute = (title: string, worker: string, system: string, prompt: string, verb: string, skippable = false) =>
      streamCard(my, title, verb, (onDelta) => runWorker(worker, system, prompt, onDelta, () => {}), skippable);

    for (let r = 1; r <= rt.rounds; r++) {
      for (let pi = 0; pi < parts.length; pi++) {
        if (my !== genId) return;
        const { worker, skill } = parts[pi];
        // Each participant's skill (if any) layers on top of the shared discussion role.
        const skillText = skill ? bodies[skill] ?? "" : "";
        const system = [skillText, baseSys].map((s) => s.trim()).filter(Boolean).join("\n\n");
        // No good answer yet (first overall, or an earlier drafter failed) → draft fresh.
        const first = !draft;
        const prompt = first
          ? `问题：\n${Q}\n\n请给出你的回答：尽量完整、准确、有依据。`
          : `问题：\n${Q}\n\n目前的答案（由上一位参与者给出）：\n"""\n${draft}\n"""\n\n请在此基础上改进：补充遗漏、纠正错误或不准确之处、删去冗余空话，让答案更完整准确。直接输出改进后的【完整答案】，不要只写"我改了什么"，也不要加解释。`;
        const heading = `第 ${r} 轮 · ${workerLabel(worker)}${skill ? ` · 技能:${skill}` : ""}`;
        const res = await contribute(
          heading,
          worker,
          system,
          prompt,
          first ? "起草中" : "改进中",
          true, // skippable: a failed participant is skipped, not fatal
        );
        if (my !== genId) return; // 「停止」→ 整场中止
        // 出错的这位：卡片已显示报错，跳过它、保留上一份好答案，继续下一位——
        // 一个模型挂了不该让整场圆桌停摆。
        if (res) {
          draft = res.text;
          transcript.push({ label: workerLabel(worker), round: r, text: res.text });
          exportEntries.push({ heading, getText: res.getText });
        }
      }
    }

    if (my !== genId) return;
    if (!transcript.length) {
      toast("所有参与模型都没成功，没法综述——看各卡片的报错，多半是某个模型的参数 / Key 问题");
      return;
    }
    const tx = transcript
      .map((t) => `【第 ${t.round} 轮 · ${t.label}】\n${t.text.slice(0, 6000)}`)
      .join("\n\n");
    const modPrompt = `问题：\n${Q}\n\n以下是多个模型多轮接力改进的完整记录：\n\n${tx}\n\n请你作为主持人综述，用 Markdown 分三节：\n## 共识\n大家一致认可的结论。\n## 分歧与演变\n观点如何变化、还有哪些不同看法或未解的问题。\n## 最终建议\n综合各方，给出你认为最好的最终答案。`;
    const modHeading = `主持人综述 · ${workerLabel(rt.moderator)}`;
    const modRes = await contribute(
      modHeading,
      rt.moderator,
      "你是这场多模型讨论的主持人，客观中立，善于提炼共识与分歧。",
      modPrompt,
      "综述中",
    );
    if (my !== genId) return;
    if (modRes) exportEntries.push({ heading: modHeading, getText: modRes.getText });

    // Export the whole session (question + every contribution + synthesis) as .md / .txt.
    const buildMarkdown = () => {
      let s = `# 圆桌讨论\n\n**问题**\n\n${Q}\n`;
      for (const e of exportEntries) s += `\n\n## ${e.heading}\n\n${e.getText().trim()}\n`;
      return s + "\n";
    };
    const buildText = () => {
      const bar = "=".repeat(40);
      let s = `圆桌讨论\n\n问题：\n${Q}\n`;
      for (const e of exportEntries) s += `\n\n${bar}\n${e.heading}\n${bar}\n\n${e.getText().trim()}\n`;
      return s + "\n";
    };
    makeExportToolbar("整场", rt.question.trim() || "圆桌讨论", buildMarkdown, buildText);
    pushHistory("rt", rt.question.trim() || "圆桌讨论", buildMarkdown());
  } catch (e) {
    if (my === genId) toast(e instanceof Error ? e.message : String(e));
  } finally {
    endRun(my);
  }
}

// ---- 运行历史 viewer ----
const historyModal = $<HTMLDivElement>("#history-modal");
let historyViewId: string | null = null;
function saveHistoryLS() {
  localStorage.setItem(LS_HISTORY, JSON.stringify(history));
}
function renderHistory() {
  const listEl = $<HTMLDivElement>("#history-list");
  const viewEl = $<HTMLPreElement>("#history-view");
  listEl.innerHTML = "";
  if (!history.length) {
    const empty = document.createElement("div");
    empty.className = "sidebar-note";
    empty.textContent = "还没有历史。跑一次任何模式就会自动存。";
    listEl.appendChild(empty);
    viewEl.textContent = "";
    historyViewId = null;
    return;
  }
  if (!historyViewId || !history.some((h) => h.id === historyViewId)) historyViewId = history[0].id;
  for (const h of history) {
    const item = document.createElement("div");
    item.className = "history-item" + (h.id === historyViewId ? " active" : "");
    const t = new Date(h.time);
    const when = `${t.getMonth() + 1}-${t.getDate()} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
    const title = document.createElement("span");
    title.className = "h-title";
    title.textContent = h.title;
    const meta = document.createElement("span");
    meta.className = "h-meta";
    meta.textContent = `${MODE_LABEL[h.mode] ?? h.mode} · ${when}`;
    const del = document.createElement("button");
    del.className = "danger mini h-del";
    del.textContent = "✕";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      history = history.filter((x) => x.id !== h.id);
      if (historyViewId === h.id) historyViewId = null;
      saveHistoryLS();
      renderHistory();
    });
    item.append(title, meta, del);
    item.addEventListener("click", () => {
      historyViewId = h.id;
      renderHistory();
    });
    listEl.appendChild(item);
  }
  const cur = history.find((h) => h.id === historyViewId);
  viewEl.textContent = cur ? cur.md : "";
}

// ---- 技能库大窗（按分类浏览 / 搜索 / 管理）----
const skillsModal = $<HTMLDivElement>("#skills-modal");
let sklCat = "全部";
let sklSearch = "";
// Track the dragged skill via a module var (WKWebView's dataTransfer is unreliable —
// same pattern as the geo/rt/code card drag).
let sklDragName: string | null = null;
// Re-save a skill with a new category (keeps its description + body). Used by drag-to-category.
async function setSkillCategory(name: string, category: string) {
  try {
    const content = await invoke<string>("read_skill", { name });
    const m = content.match(/^description:\s*(.*)$/m);
    await invoke("save_skill", { name, description: m ? m[1].trim() : "", category, body: skillBody(content) });
    await refreshSkills(); // re-renders sidebar + this modal
    toast(`「${name}」已移到「${category || "未分类"}」`, "info");
  } catch (e) {
    toast("移动失败：" + (e instanceof Error ? e.message : String(e)));
  }
}
function renderSkillsModal() {
  const catsEl = $<HTMLDivElement>("#skl-cats");
  const gridEl = $<HTMLDivElement>("#skl-grid");
  const counts = new Map<string, number>();
  for (const s of skills) {
    const c = s.category.trim() || "未分类";
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const cats = ["全部", ...allCategories(), ...(counts.has("未分类") ? ["未分类"] : [])];
  if (!cats.includes(sklCat)) sklCat = "全部";

  catsEl.innerHTML = "";
  // ＋ 新建分类: type a name → it becomes a (possibly empty) category you can assign to skills.
  const addRow = document.createElement("div");
  addRow.className = "skl-cat-add";
  const addInput = document.createElement("input");
  addInput.placeholder = "新建分类…";
  const addBtn = document.createElement("button");
  addBtn.className = "mini";
  addBtn.textContent = "＋";
  const commit = () => {
    const name = addInput.value.trim();
    if (!name) return;
    if (!allCategories().includes(name)) {
      customCategories.push(name);
      saveCustomCats();
    }
    addInput.value = "";
    sklCat = name;
    renderSkillsModal();
  };
  addBtn.addEventListener("click", commit);
  addInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
  });
  addRow.append(addInput, addBtn);
  catsEl.appendChild(addRow);
  for (const c of cats) {
    const item = document.createElement("div");
    item.className = "skl-cat" + (c === sklCat ? " active" : "");
    const label = document.createElement("span");
    label.textContent = c;
    const cnt = document.createElement("span");
    cnt.className = "skl-count";
    cnt.textContent = String(c === "全部" ? skills.length : counts.get(c) ?? 0);
    item.append(label, cnt);
    item.addEventListener("click", () => {
      sklCat = c;
      renderSkillsModal();
    });
    // Drop a skill card here to move it into this category ("全部" isn't a real target).
    if (c !== "全部") {
      item.addEventListener("dragover", (e) => {
        e.preventDefault();
        item.classList.add("drop-hover");
      });
      item.addEventListener("dragleave", () => item.classList.remove("drop-hover"));
      item.addEventListener("drop", (e) => {
        e.preventDefault();
        item.classList.remove("drop-hover");
        if (sklDragName) void setSkillCategory(sklDragName, c === "未分类" ? "" : c);
        sklDragName = null;
      });
    }
    catsEl.appendChild(item);
  }

  const q = sklSearch.trim().toLowerCase();
  const filtered = skills.filter((s) => {
    const c = s.category.trim() || "未分类";
    if (sklCat !== "全部" && c !== sklCat) return false;
    if (q && !(s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))) return false;
    return true;
  });
  gridEl.innerHTML = "";
  if (!filtered.length) {
    const e = document.createElement("div");
    e.className = "skl-empty";
    e.textContent = !skills.length
      ? "技能库还是空的。点「＋ 新建技能」或「⇄ 仓库」。"
      : sklCat !== "全部" && sklCat !== "未分类"
        ? `「${sklCat}」分类暂无技能——新建 / 编辑技能时把「分类」选成「${sklCat}」即可归入。`
        : "没有匹配的技能。";
    gridEl.appendChild(e);
    return;
  }
  for (const s of filtered) {
    const card = document.createElement("div");
    card.className = "skl-card";
    card.draggable = true; // drag onto a category (left) to move it there
    card.addEventListener("dragstart", () => (sklDragName = s.name));
    const head = document.createElement("div");
    head.className = "skl-card-head";
    const nm = document.createElement("span");
    nm.className = "skl-card-name";
    nm.textContent = s.name;
    const edit = document.createElement("button");
    edit.className = "skill-edit mini";
    edit.textContent = "✎";
    edit.title = "编辑";
    edit.addEventListener("click", () => openSkillEditor(s.name));
    const del = document.createElement("button");
    del.className = "skill-edit mini";
    del.textContent = "🗑";
    del.title = "删除（点两下确认）";
    twoStepDelete(del, "🗑", "确认?", () => void doDeleteSkill(s.name));
    head.append(nm, edit, del);
    card.append(head);
    if (s.category.trim()) {
      const cat = document.createElement("span");
      cat.className = "skl-card-cat";
      cat.textContent = "🏷 " + s.category.trim();
      card.append(cat);
    }
    const desc = document.createElement("div");
    desc.className = "skl-card-desc";
    desc.textContent = s.description || "（无描述）";
    card.append(desc);

    // Reliable (non-drag) way to move a skill into a category: a dropdown.
    const moveRow = document.createElement("div");
    moveRow.className = "skl-move-row";
    const moveLab = document.createElement("span");
    moveLab.textContent = "分类";
    const move = document.createElement("select");
    move.className = "skl-move";
    move.title = "移动到分类";
    const cur = s.category.trim();
    for (const cat of ["", ...allCategories()]) {
      const o = document.createElement("option");
      o.value = cat;
      o.textContent = cat || "未分类";
      if (cat === cur) o.selected = true;
      move.appendChild(o);
    }
    move.addEventListener("change", () => void setSkillCategory(s.name, move.value));
    moveRow.append(moveLab, move);
    card.append(moveRow);

    gridEl.appendChild(card);
  }
}
function openSkillsModal() {
  renderSkillsModal();
  skillsModal.classList.remove("hidden");
}

// ---- 协作编程 mode ----
const codeEditor = $<HTMLElement>("#code-editor");

let codeDragIdx: number | null = null;
function renderCodeAgents() {
  const wrap = $<HTMLDivElement>("#code-agents");
  wrap.innerHTML = "";
  const opts = codingAgentOptions();
  if (!code.agents.length) {
    const note = document.createElement("div");
    note.className = "sidebar-note";
    note.textContent =
      "还没有 Agent。点「＋ 加一位」加本地 CLI（Claude Code / Codex / Gemini / Grok），并给每位写明职责。HTTP 模型不能改文件，这里不列。";
    wrap.appendChild(note);
  }
  code.agents.forEach((a, i) => {
    const cardEl = document.createElement("div");
    cardEl.className = "code-agent";
    cardEl.draggable = true;
    cardEl.addEventListener("dragstart", () => (codeDragIdx = i));
    cardEl.addEventListener("dragover", (e) => e.preventDefault());
    cardEl.addEventListener("drop", (e) => {
      e.preventDefault();
      if (codeDragIdx === null || codeDragIdx === i) return;
      const [m] = code.agents.splice(codeDragIdx, 1);
      code.agents.splice(i, 0, m);
      codeDragIdx = null;
      saveCode();
      renderCodeAgents();
    });

    const head = document.createElement("div");
    head.className = "code-agent-head";
    const handle = document.createElement("span");
    handle.className = "geo-handle";
    handle.textContent = "⠿";
    const num = document.createElement("span");
    num.className = "rt-num";
    num.textContent = `${i + 1}.`;

    const sel = document.createElement("select");
    const list =
      a.worker && !opts.some((o) => o.value === a.worker)
        ? [...opts, { value: a.worker, label: `（已失效）${workerLabel(a.worker)}` }]
        : opts;
    fillSelect(sel, list, a.worker);
    sel.addEventListener("change", () => {
      a.worker = sel.value;
      saveCode();
    });

    const del = document.createElement("button");
    del.className = "danger mini";
    del.textContent = "✕";
    del.addEventListener("click", () => {
      code.agents.splice(i, 1);
      saveCode();
      renderCodeAgents();
    });
    head.append(handle, num, sel, del);

    const duty = document.createElement("input");
    duty.className = "code-agent-duty";
    // Position-specific hint, so each row suggests a different job and an empty field
    // still reads as "this slot = this duty" (which is what actually runs — see runCoding).
    duty.placeholder = `职责（留空则按「${DUTY_SUGGEST[i] ?? "审查与完善"}」）`;
    duty.value = a.duty;
    duty.addEventListener("input", () => {
      a.duty = duty.value;
      saveCode();
    });

    // Skills: toggleable chips — click to attach/detach, pick as many as you want.
    a.skills = a.skills.filter((n) => skills.some((s) => s.name === n)); // drop deleted skills
    const skillRow = document.createElement("div");
    skillRow.className = "skill-chips";
    const lab = document.createElement("span");
    lab.className = "wfbar-label";
    lab.textContent = "技能";
    skillRow.appendChild(lab);
    if (!skills.length) {
      const none = document.createElement("span");
      none.className = "chips-empty";
      none.textContent = "（技能库为空，去左边「技能」新建）";
      skillRow.appendChild(none);
    }
    for (const s of skills) {
      const chip = document.createElement("button");
      chip.className = "skill-chip" + (a.skills.includes(s.name) ? " active" : "");
      chip.textContent = s.name;
      chip.title = s.description || s.name;
      chip.addEventListener("click", () => {
        if (a.skills.includes(s.name)) a.skills = a.skills.filter((n) => n !== s.name);
        else a.skills.push(s.name);
        saveCode();
        chip.classList.toggle("active");
      });
      skillRow.appendChild(chip);
    }

    cardEl.append(head, duty, skillRow);
    wrap.appendChild(cardEl);
  });
}

let dirCheckSeq = 0;
async function validateCodeDir() {
  const el = $("#code-dir-status");
  const dir = code.dir.trim();
  if (!dir) {
    el.className = "test-status";
    el.textContent = "";
    return;
  }
  const seq = ++dirCheckSeq;
  const ok = await invoke<boolean>("dir_exists", { path: dir }).catch(() => false);
  if (seq !== dirCheckSeq) return;
  setTest(el, ok ? "ok" : "error", ok ? "✓ 文件夹存在" : "✗ 找不到这个文件夹");
}

function renderCode() {
  $<HTMLInputElement>("#code-dir").value = code.dir;
  $<HTMLTextAreaElement>("#code-task").value = code.task;
  $<HTMLInputElement>("#code-role").value = code.role;
  $<HTMLInputElement>("#code-auto").checked = code.auto;
  $<HTMLInputElement>("#code-loop").checked = code.loop;
  $<HTMLInputElement>("#code-loop-mins").value = String(code.loopMins || 2.5);
  renderCodeAgents();
  validateCodeDir();
}

// 协作编程: give each agent its own LIVE interactive terminal (PTY), side by side, in
// the same project folder. Seeded with its duty + the task + a TEAM_NOTES.md convention
// so review/test agents leave feedback the implementer reads. You watch + type follow-ups.
async function runCoding() {
  const dir = code.dir.trim();
  if (!dir) return toast("先填项目文件夹路径");
  if (!code.task.trim()) return toast("先填任务 / 需求");
  const agents = code.agents.filter((a) => codingProgram(a.worker));
  if (!agents.length) return toast("至少加 1 个有效的 Agent");
  const dirOk = await invoke<boolean>("dir_exists", { path: dir }).catch(() => false);
  if (!dirOk) return toast("项目文件夹不存在：" + dir);

  pushCodeTask(); // snapshot this run's config into 历史任务 before we launch

  // Effective skills per agent = its own + the default (left-library checked) skills.
  const agentSkills = (a: CodeAgent) => [...new Set([...defaultSkills, ...a.skills])];
  // Preload every needed skill's body once.
  const bodies: Record<string, string> = {};
  for (const a of agents) {
    for (const sk of agentSkills(a)) {
      if (!(sk in bodies)) {
        try {
          bodies[sk] = skillBody(await invoke<string>("read_skill", { name: sk }));
        } catch {
          bodies[sk] = "";
        }
      }
    }
  }

  const task = code.task.trim();
  const conv = code.role.trim() ? `团队约定：${code.role.trim()}\n` : "";
  const notes =
    "队友之间通过项目根目录的 TEAM_NOTES.md 互通：发现问题/给出反馈就追加写进 TEAM_NOTES.md（注明针对哪个文件、什么问题）；动手前先看一眼 TEAM_NOTES.md 有没有给你的反馈。";

  // Move into the terminal panes and give each agent its own live terminal.
  mode = "term";
  localStorage.setItem(LS_MODE, mode);
  applyMode();
  resetPanes();

  agents.forEach((a, i) => {
    const program = codingProgram(a.worker);
    if (!program) return;
    const role = a.duty.trim() || DUTY_SUGGEST[i] || "实现";
    const skillText = agentSkills(a)
      .map((sk) => (bodies[sk] ?? "").trim())
      .filter(Boolean)
      .join("\n\n");
    const isImpl = i === 0 || role.includes("实现");
    const prompt =
      `${conv}你是多 Agent 协作小组的一员，负责：${role}。我们共用当前这个项目文件夹。\n\n` +
      `总任务：\n${task}\n\n` +
      (skillText ? `${skillText}\n\n` : "") +
      `${notes}\n\n` +
      (isImpl
        ? "先快速过一遍当前项目代码和 TEAM_NOTES.md，判断这个任务已经做到哪一步了：如果之前已经做了一部分（这是续上一次、不是全新开始），就从没做完的地方接着做，绝不重复已经完成的工作；全新的才从头开始。确认进度后再动手、直接改文件。工作方式：每完成一步，先把这一步简要记进 TEAM_NOTES.md（当进度清单，方便重启后续上），再看一眼有没有队友给你的新反馈——有就按反馈改，没有就直接做下一步；就这样一步步自己推进，全程不要停下来问我、也不要等我确认，直到整个任务真正完成（全部做完了再说一声）。"
        : "先看一遍当前代码和 TEAM_NOTES.md（可能是续上一次、不是全新开始），围绕你的职责动手（审查/修 bug/补测试/重构）；把要给别人的反馈写进 TEAM_NOTES.md——TEAM_NOTES.md 里已经提过的别重复提，只补新问题；简述你改了什么。");
    // One pane per agent (side by side) up to MAX_PANES; extra agents become tabs in the
    // last pane. Each launches the CLI interactively (no -p) seeded with the prompt.
    let pane: Pane;
    if (i < MAX_PANES) pane = addPane();
    else {
      pane = panes[panes.length - 1];
      pane.addTab(dir);
    }
    const spec = CLI_LAUNCH[program];
    const auto = code.auto && spec ? spec.auto : [];
    // Only auto-confirm the startup dialog when its triggering flag (auto) is on.
    const accept = code.auto ? spec?.accept : undefined;
    if (spec && !spec.promptArg) {
      // CLI won't take a positional prompt (grok) — launch bare + type it into stdin.
      pane.active!.launch(program, auto, dir, prompt, accept);
    } else {
      pane.active!.launch(program, [...auto, prompt], dir, undefined, accept);
    }

    // 持续协作: periodically re-prompt this agent to re-scan the project + TEAM_NOTES.md,
    // so the team keeps reacting to each other's changes instead of stopping after one pass.
    if (code.loop) {
      const term = pane.active!;
      // Short nudge — the agent already knows its role/the TEAM_NOTES.md convention from launch,
      // so we don't re-type a long paragraph (that also got stuck in the TUI input box). The
      // implementer keeps moving to the next step instead of waiting; reviewers re-scan.
      const nudge = isImpl
        ? `先看 TEAM_NOTES.md 有没有新反馈：有就按反馈改，没有就直接做任务的下一步——不要停下来问我、也不要等我确认。整个任务都做完了再回"全部完成"。`
        : `再巡检一遍：代码和 TEAM_NOTES.md 有没有新变化，有问题就处理并写进 TEAM_NOTES.md，没有就回"暂无"。`;
      // Implementer continues promptly once it goes idle (it shouldn't wait minutes between
      // steps); reviewers/testers re-scan on the slower user-set cadence.
      const minGapMs = isImpl ? 15000 : Math.max(0.5, code.loopMins || 2.5) * 60000 + i * 5000;
      const QUIET = 8000; // ms of no output ⇒ agent finished its turn (TUIs animate while busy)
      const USER_QUIET = 12000; // don't butt in if you typed recently
      let lastFire = Date.now(); // first launch already gave it the task — wait a full interval
      // Poll often, but only actually nudge when the agent is idle AND the interval has elapsed,
      // so the prompt never lands mid-task or while you're typing.
      const timer = window.setInterval(() => {
        if (!term.sessionId) {
          clearInterval(timer);
          return;
        }
        const now = Date.now();
        if (now - lastFire < minGapMs) return; // respect the chosen interval
        if (now - term.lastOutputAt < QUIET) return; // still working — wait for it to go quiet
        if (now - term.lastInputAt < USER_QUIET) return; // you're typing — don't interrupt
        lastFire = now;
        const sid = term.sessionId;
        // Type the text, then send Enter as a SEPARATE write — a trailing \r in the same
        // chunk gets absorbed by the TUI's paste handling and the line just sits there unsent.
        invoke("write_pty", { id: sid, data: nudge }).catch(() => {});
        setTimeout(() => term.sessionId === sid && invoke("write_pty", { id: sid, data: "\r" }).catch(() => {}), 350);
      }, 10000);
      codeLoopTimers.push(timer);
    }
  });

  if (code.loop)
    toast(`已开启持续协作：各 Agent 空闲后约每 ${code.loopMins || 2.5} 分钟自动巡检/推进一次（关掉「持续协作」或关终端即停）`, "info");
}

// ---- 终端 mode (embedded xterm + PTY, ported from clink: split panes + tabs + launcher) ----
const termPanel = $<HTMLElement>("#term-panel");
const panesEl = () => $<HTMLDivElement>("#panes");
const panes: Pane[] = [];
let paneSeq = 0;
let termSeq = 0;
let sessionSeq = 0;
let activePane: Pane | null = null;
const MAX_PANES = 3;

function escHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
function shortCwd(cwd: string): string {
  if (!cwd) return "";
  return cwd.startsWith("/Users/") ? "~/" + cwd.split("/").slice(3).join("/") : cwd;
}

// One terminal session (a tab). Shows a launcher until a program is started.
class Term {
  id = `t${++termSeq}`;
  host: HTMLElement;
  term: Terminal | null = null;
  fit: FitAddon | null = null;
  sessionId: string | null = null;
  lastOutputAt = 0; // ms of last PTY output — used by 持续协作 to tell when the agent is idle
  lastInputAt = 0; // ms of last user keystroke — so auto-巡检 never interrupts your typing
  cwd = "~";
  program = "";
  title = "";
  launched = false; // true once a program has been started (a plain shell counts)
  private unlisten: UnlistenFn | null = null;
  private ro: ResizeObserver | null = null;
  private refitRaf = 0;

  constructor(
    public pane: Pane,
    private initialCwd = "~",
  ) {
    this.host = document.createElement("div");
    this.host.className = "term-host";
    this.showLauncher();
  }

  private showLauncher() {
    // No skill picker here — skills are called anytime during the session via the pane's
    // ⚡技能 button (write_pty into the running CLI), which is the better workflow.
    this.host.innerHTML = `
      <div class="launcher">
        <div class="launch-row"><label>目录</label><input class="cwd" value="~" /><button class="pick-cwd" type="button">选择</button></div>
        <div class="launch-row"><label>参数</label><input class="args" placeholder="可选，传给程序的参数" /></div>
        <div class="launch-btns">
          <button data-prog="">▶ 终端</button>
          <button data-prog="claude">▶ Claude</button>
          <button data-prog="codex">▶ Codex</button>
          <button data-prog="grok">▶ Grok</button>
        </div>
      </div>`;
    const cwdInput = this.host.querySelector(".cwd") as HTMLInputElement;
    cwdInput.value = this.initialCwd;
    this.host.querySelector(".pick-cwd")!.addEventListener("click", async () => {
      const dir = await invoke<string | null>("pick_folder").catch(() => null);
      if (dir) cwdInput.value = dir;
    });
    this.host.querySelectorAll<HTMLButtonElement>(".launch-btns button").forEach((b) =>
      b.addEventListener("click", () => {
        const cwd = cwdInput.value || "~";
        const argStr = (this.host.querySelector(".args") as HTMLInputElement).value.trim();
        this.launch(b.dataset.prog ?? "", argStr ? argStr.split(/\s+/) : [], cwd);
      }),
    );
  }

  async launch(program: string, args: string[], cwd: string, seed?: string, accept?: string) {
    this.teardown();
    this.host.innerHTML = "";
    const term = new Terminal({
      fontFamily: "Menlo, Monaco, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      macOptionClickForcesSelection: true,
      theme: { background: "#1e1e1e", foreground: "#d4d4d4" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(this.host);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      /* no WebGL — default renderer */
    }
    try {
      fit.fit();
    } catch {
      /* not laid out yet */
    }
    this.term = term;
    this.fit = fit;
    const sid = `s${++sessionSeq}`;
    this.sessionId = sid;
    this.cwd = cwd;
    this.program = program;
    this.launched = true;
    this.title = `${program || "shell"} · ${shortCwd(cwd) || cwd}`;
    this.pane.renderTabs();

    // Watch the stream for a startup confirm dialog (claude's "Yes, I accept") and, once
    // it actually renders, select option 2 (Down then Enter). Doing it on detection — not
    // a blind timer — avoids the keystroke landing before the menu (which picked "No, exit").
    let acceptDone = !accept;
    let acceptBuf = "";
    const onData = new Channel<ArrayBuffer>();
    onData.onmessage = (msg) => {
      const bytes = new Uint8Array(msg);
      this.lastOutputAt = Date.now();
      if (this.term) this.term.write(bytes);
      if (!acceptDone) {
        acceptBuf = (acceptBuf + new TextDecoder().decode(bytes)).slice(-6000);
        // The menu's words get split by cursor-move escapes, so match the contiguous tokens
        // "confirm" (Enter to confirm) + "exit" (1. No, exit) — both present = menu is up.
        if (/confirm/i.test(acceptBuf) && /exit/i.test(acceptBuf)) {
          acceptDone = true;
          setTimeout(() => invoke("write_pty", { id: sid, data: "\x1b[B" }).catch(() => {}), 300);
          setTimeout(() => invoke("write_pty", { id: sid, data: "\r" }).catch(() => {}), 650);
        }
      }
    };
    this.unlisten = await listen(`pty:exit:${sid}`, () => {
      term.writeln("\r\n\x1b[90m[进程已退出]\x1b[0m");
      if (this.sessionId === sid) this.sessionId = null;
    });
    try {
      await invoke("spawn_pty", { id: sid, program, args, cwd, cols: term.cols, rows: term.rows, onData });
    } catch (err) {
      if (this.sessionId === sid) this.sessionId = null;
      term.writeln(`\x1b[31m启动失败：${err instanceof Error ? err.message : String(err)}\x1b[0m`);
      return;
    }
    term.onData((d) => {
      this.lastInputAt = Date.now();
      invoke("write_pty", { id: sid, data: d }).catch(() => {});
    });

    // Seed a prompt by typing it into the CLI's stdin (for CLIs that don't take a
    // positional prompt, e.g. grok). Collapse newlines to one line so a TUI input box
    // doesn't submit early; wait a beat for the TUI to be ready, then send + Enter.
    if (seed) {
      const oneLine = seed.replace(/\s*\n+\s*/g, " ").trim();
      setTimeout(() => invoke("write_pty", { id: sid, data: oneLine + "\r" }).catch(() => {}), 1400);
    }
    // ⌘C copies selection (Ctrl+C still sends SIGINT), ⌘V pastes, ⌘K clears.
    let lastSel = "";
    term.onSelectionChange(() => {
      const s = term.getSelection();
      if (s) lastSel = s;
    });
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.metaKey) return true;
      if (e.key === "k") {
        term.clear();
        return false;
      }
      if (e.key === "c") {
        const s = term.getSelection() || lastSel;
        if (!s) return true;
        navigator.clipboard.writeText(s).catch(() => {});
        return false;
      }
      if (e.key === "v") {
        navigator.clipboard
          .readText()
          .then((t) => t && term.paste(t))
          .catch(() => {});
        return false;
      }
      return true;
    });

    this.ro = new ResizeObserver(() => this.refit());
    this.ro.observe(this.host);
    this.pane.setActiveTerm(this);
  }

  refit() {
    if (this.refitRaf) return;
    this.refitRaf = requestAnimationFrame(() => {
      this.refitRaf = 0;
      if (!this.term || !this.fit) return;
      if (this.host.clientWidth === 0 || this.host.clientHeight === 0) return;
      try {
        this.fit.fit();
      } catch {
        /* not laid out yet */
      }
      if (this.sessionId)
        invoke("resize_pty", { id: this.sessionId, cols: this.term.cols, rows: this.term.rows }).catch(() => {});
    });
  }

  teardown() {
    if (this.refitRaf) cancelAnimationFrame(this.refitRaf);
    this.refitRaf = 0;
    this.ro?.disconnect();
    this.ro = null;
    this.unlisten?.();
    this.unlisten = null;
    if (this.sessionId) invoke("close_pty", { id: this.sessionId }).catch(() => {});
    this.sessionId = null;
    this.term?.dispose();
    this.term = null;
    this.fit = null;
  }
}

// A column: a tab strip + the active tab's body. Holds one or more Terms.
class Pane {
  id = `pane-${++paneSeq}`;
  root: HTMLElement;
  tabsEl: HTMLElement;
  bodyEl: HTMLElement;
  grow = 1;
  tabs: Term[] = [];
  active: Term | null = null;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "pane";
    this.root.innerHTML = `<div class="pane-tabs"></div><div class="pane-body"></div>`;
    this.tabsEl = this.root.querySelector(".pane-tabs")!;
    this.bodyEl = this.root.querySelector(".pane-body")!;
    this.root.addEventListener("mousedown", () => setActivePane(this), true);
    this.addTab();
  }

  addTab(initialCwd = "~"): Term {
    const t = new Term(this, initialCwd);
    this.tabs.push(t);
    this.bodyEl.appendChild(t.host);
    this.setActiveTerm(t);
    return t;
  }

  closeTab(t: Term) {
    t.teardown();
    t.host.remove();
    const i = this.tabs.indexOf(t);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    if (this.tabs.length === 0) {
      if (panes.length > 1) {
        removePane(this);
        return;
      }
      this.addTab(); // keep at least one tab in the last column
      return;
    }
    if (this.active === t) this.setActiveTerm(this.tabs[Math.max(0, i - 1)]);
    else this.renderTabs();
  }

  // All tab hosts stay mounted; switching only toggles visibility, so the active
  // terminal's canvas is never blanked.
  setActiveTerm(t: Term) {
    this.active = t;
    this.tabs.forEach((tm) => tm.host.classList.toggle("term-host--hidden", tm !== t));
    this.renderTabs();
    setActivePane(this);
    t.refit();
    t.term?.focus();
  }

  renderTabs() {
    this.tabsEl.innerHTML = "";
    for (const tm of this.tabs) {
      const label = tm.launched ? tm.title : "新终端";
      const chip = document.createElement("div");
      chip.className = "tab" + (tm === this.active ? " active" : "");
      chip.innerHTML = `<span class="tab-title">${escHtml(label)}</span><button class="tab-close" title="关闭">✕</button>`;
      chip.addEventListener("click", () => this.setActiveTerm(tm));
      chip.querySelector(".tab-close")!.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeTab(tm);
      });
      this.tabsEl.appendChild(chip);
    }
    const add = document.createElement("button");
    add.className = "tab-add";
    add.textContent = "+";
    add.title = "新标签页";
    add.addEventListener("click", (e) => {
      e.stopPropagation();
      this.addTab(this.active?.cwd); // new tab inherits the active tab's cwd
    });
    this.tabsEl.appendChild(add);
    // ⚡ send a skill into the active terminal's running CLI — anytime, mid-conversation.
    const sk = document.createElement("button");
    sk.className = "tab-add";
    sk.textContent = "⚡技能";
    sk.title = "发送一个技能给当前终端里的 CLI";
    sk.addEventListener("click", (e) => {
      e.stopPropagation();
      openTermSkillPicker(this.active);
    });
    this.tabsEl.appendChild(sk);
  }

  refit() {
    this.active?.refit();
  }
}

function setActivePane(p: Pane) {
  activePane = p;
  panes.forEach((pp) => pp.root.classList.toggle("active", pp === p));
}
function addPane(): Pane {
  const p = new Pane();
  panes.push(p);
  setActivePane(p);
  layoutPanes();
  return p;
}
// Tear down every pane/terminal and clear the area (used by 协作编程 before launching
// one fresh terminal per agent).
function resetPanes() {
  clearCodeLoop(); // stop any 持续协作 timers from a previous run
  panes.forEach((p) => p.tabs.forEach((t) => t.teardown()));
  panes.length = 0;
  activePane = null;
  panesEl().replaceChildren();
}
function removePane(p: Pane) {
  p.tabs.forEach((t) => t.teardown());
  panes.splice(panes.indexOf(p), 1);
  if (panes.length === 0) {
    addPane();
    return;
  }
  if (activePane === p) setActivePane(panes[0]);
  layoutPanes();
}
// Rebuild #panes with draggable dividers; re-appending a pane node only moves it, so
// the live terminals inside are preserved.
function layoutPanes() {
  const el = panesEl();
  el.replaceChildren();
  panes.forEach((p, i) => {
    p.root.style.flex = `${p.grow} 1 0`;
    el.appendChild(p.root);
    if (i < panes.length - 1) el.appendChild(makeDivider(panes[i], panes[i + 1]));
  });
  refitAllPanes();
}
// Add one column, up to MAX_PANES; at the cap this is a no-op (so an accidental extra
// click on 终端 can't collapse your panes). Reduce by closing a pane's last tab.
function addPaneCapped() {
  if (panes.length < MAX_PANES) addPane();
}
function makeDivider(a: Pane, b: Pane): HTMLElement {
  const d = document.createElement("div");
  d.className = "divider";
  d.addEventListener("mousedown", (e) => startPaneDrag(e, a, b));
  return d;
}
function startPaneDrag(e: MouseEvent, a: Pane, b: Pane) {
  e.preventDefault();
  const startX = e.clientX;
  const wA = a.root.offsetWidth;
  const totalW = wA + b.root.offsetWidth;
  const totalGrow = a.grow + b.grow;
  const perPx = totalGrow / totalW;
  const minGrow = 140 * perPx;
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  let raf = 0;
  const onMove = (ev: MouseEvent) => {
    const newA = Math.max(minGrow, Math.min(totalGrow - minGrow, (wA + ev.clientX - startX) * perPx));
    a.grow = newA;
    b.grow = totalGrow - newA;
    a.root.style.flex = `${a.grow} 1 0`;
    b.root.style.flex = `${b.grow} 1 0`;
    if (!raf)
      raf = requestAnimationFrame(() => {
        raf = 0;
        a.refit();
        b.refit();
      });
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    a.refit();
    b.refit();
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}
function refitAllPanes() {
  panes.forEach((p) => p.refit());
}

// ---- 终端技能选择器：随时把一个技能正文作为一条消息发给运行中的 CLI ----
const termSkillModal = $<HTMLDivElement>("#term-skill-modal");
let termSkillTarget: Term | null = null;
let termSkillSearch = "";
function openTermSkillPicker(t: Term | null) {
  if (!t || !t.sessionId) return toast("这个终端还没启动 CLI，先点 ▶ 起一个");
  termSkillTarget = t;
  termSkillSearch = "";
  $<HTMLInputElement>("#term-skill-search").value = "";
  renderTermSkillList();
  termSkillModal.classList.remove("hidden");
  $<HTMLInputElement>("#term-skill-search").focus();
}
function renderTermSkillList() {
  const listEl = $<HTMLDivElement>("#term-skill-list");
  listEl.innerHTML = "";
  const q = termSkillSearch.trim().toLowerCase();
  const items = skills.filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
  if (!items.length) {
    const e = document.createElement("div");
    e.className = "sidebar-note";
    e.textContent = skills.length ? "没有匹配的技能。" : "技能库为空，去左边「技能」新建。";
    listEl.appendChild(e);
    return;
  }
  for (const s of items) {
    const row = document.createElement("div");
    row.className = "tsk-item";
    const nm = document.createElement("div");
    nm.className = "tsk-name";
    nm.textContent = s.name;
    const desc = document.createElement("div");
    desc.className = "tsk-desc";
    desc.textContent = s.description || "（无描述）";
    row.append(nm, desc);
    row.addEventListener("click", async () => {
      const t = termSkillTarget;
      if (!t || !t.sessionId) {
        termSkillModal.classList.add("hidden");
        return toast("终端已关闭");
      }
      try {
        const body = skillBody(await invoke<string>("read_skill", { name: s.name }));
        const oneLine = body.replace(/\s*\n+\s*/g, " ").trim();
        if (oneLine) await invoke("write_pty", { id: t.sessionId, data: oneLine + "\r" });
        termSkillModal.classList.add("hidden");
        toast(`已发送技能「${s.name}」给终端`, "info");
      } catch (e) {
        toast("发送失败：" + (e instanceof Error ? e.message : String(e)));
      }
    });
    listEl.appendChild(row);
  }
}

function applyMode() {
  const m = mode;
  const isTerm = m === "term";
  geoEditor.classList.toggle("hidden", m !== "geo");
  pipeEditor.classList.toggle("hidden", m !== "pipe");
  rtEditor.classList.toggle("hidden", m !== "rt");
  codeEditor.classList.toggle("hidden", m !== "code");
  termPanel.classList.toggle("hidden", !isTerm);
  // 终端 mode takes the whole area: hide the results column + its splitter.
  (document.querySelector(".results") as HTMLElement).classList.toggle("hidden", isTerm);
  $("#col-splitter").classList.toggle("hidden", isTerm);
  $("#add-step").classList.toggle("hidden", m !== "pipe");
  wfbar.classList.toggle("hidden", m !== "pipe");
  $("#mode-pipe").classList.toggle("active", m === "pipe");
  $("#mode-geo").classList.toggle("active", m === "geo");
  $("#mode-rt").classList.toggle("active", m === "rt");
  $("#mode-code").classList.toggle("active", m === "code");
  $("#mode-term").classList.toggle("active", isTerm);
  // 终端 has no run/stop (terminals are live + independent); hide those buttons there.
  runBtn.classList.toggle("hidden", isTerm);
  stopBtn.classList.toggle("hidden", isTerm || !running);
  document.getElementById("geo-empty-hint")?.remove();
  renderSkills(); // click behavior + highlight differ per mode
  if (m === "code") renderCode();
  else if (m === "geo") renderGeo();
  else if (m === "rt") renderRt();
  else if (isTerm) {
    // First entry creates a pane; later entries refit (panes were display:none while away).
    if (!panes.length) addPane();
    else refitAllPanes();
  }
  // Per-mode empty-state hint (pipe has its own inline ref-hint, so no entry here).
  const hint = EMPTY_HINTS[m];
  if (hint && !resultsEl.children.length) {
    const el = document.createElement("div");
    el.id = "geo-empty-hint";
    el.className = "empty";
    el.textContent = hint;
    resultsEl.appendChild(el);
  }
}
const EMPTY_HINTS: Record<string, string> = {
  code: "填好项目文件夹、任务、加 ≥1 个本地 CLI Agent，点「运行」→ 切到终端，每个 Agent 各开一个实时终端、并排干活。",
  geo: "填好左侧表单（标题 / 原文 / 链接 / 路线 任一即可），点「运行」生成结构文 + 小推文。",
  rt: "填好问题、加 ≥2 个参与模型、选一个主持人，点「运行」开始多模型接力讨论。",
};

// ---- wire up ----
$("#toggle-skills").addEventListener("click", () => {
  const hidden = skillsPanel.classList.toggle("hidden");
  $("#side-splitter").classList.toggle("hidden", hidden); // splitter follows the sidebar
});
$("#add-step").addEventListener("click", () => {
  steps.push({ title: "新步骤", worker: "", role: "", prompt: "{{prev}}" });
  saveSteps();
  renderSteps();
});
runBtn.addEventListener("click", () =>
  mode === "geo" ? runGeo() : mode === "rt" ? runRoundtable() : mode === "code" ? runCoding() : run(),
);
stopBtn.addEventListener("click", () => {
  genId++; // invalidate the in-flight run so any pending await no-ops
  if (cancelCurrent) cancelCurrent();
  // Always unstick the UI, even if we're blocked on a pre-stream await (fetch/skill read).
  running = false;
  cancelCurrent = null;
  stopBtn.classList.add("hidden");
  runBtn.classList.remove("hidden");
});

// ---- draggable column splitters (widths persisted in localStorage) ----
// `compute` turns the .main rect + cursor X into a new px width; `apply` sets it.
function makeColumnSplitter(
  splitterId: string,
  lsKey: string,
  compute: (rect: DOMRect, clientX: number) => number,
  apply: (w: number) => void,
) {
  const splitter = $<HTMLDivElement>(splitterId);
  const mainEl = document.querySelector(".main") as HTMLElement;
  const saved = load<number>(lsKey, 0);
  let current = saved;
  if (saved > 0) apply(saved);
  let dragging = false;
  splitter.addEventListener("mousedown", (e) => {
    dragging = true;
    splitter.classList.add("dragging");
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    current = compute(mainEl.getBoundingClientRect(), e.clientX);
    apply(current);
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove("dragging");
    document.body.style.userSelect = "";
    localStorage.setItem(lsKey, String(Math.round(current)));
  });
}
// editor ↔ results: drag sets the results column width (from the right edge).
{
  const resultsCol = document.querySelector(".results") as HTMLElement;
  makeColumnSplitter(
    "#col-splitter",
    "council.resultsw",
    (rect, x) => Math.max(280, Math.min(rect.right - x, rect.width - 380)),
    (w) => {
      resultsCol.style.flex = "none";
      resultsCol.style.width = `${w}px`;
    },
  );
}
// 技能栏 ↔ editor: drag sets the sidebar width (from the left edge).
makeColumnSplitter(
  "#side-splitter",
  "council.sidebarw",
  (rect, x) => Math.max(200, Math.min(x - rect.left, 560)),
  (w) => (skillsPanel.style.width = `${w}px`),
);

// mode toggle
$("#mode-pipe").addEventListener("click", () => {
  mode = "pipe";
  localStorage.setItem(LS_MODE, mode);
  applyMode();
});
$("#mode-geo").addEventListener("click", () => {
  mode = "geo";
  localStorage.setItem(LS_MODE, mode);
  applyMode();
});
$("#mode-rt").addEventListener("click", () => {
  mode = "rt";
  localStorage.setItem(LS_MODE, mode);
  applyMode();
});

// 圆桌 form fields
$<HTMLTextAreaElement>("#rt-question").addEventListener("input", (e) => {
  rt.question = (e.target as HTMLTextAreaElement).value;
  saveRt();
});
$<HTMLInputElement>("#rt-role").addEventListener("input", (e) => {
  rt.role = (e.target as HTMLInputElement).value;
  saveRt();
});
$<HTMLInputElement>("#rt-rounds").addEventListener("input", (e) => {
  rt.rounds = parseInt((e.target as HTMLInputElement).value, 10) || 2;
  $("#rt-rounds-val").textContent = String(rt.rounds);
  saveRt();
});
$<HTMLSelectElement>("#rt-moderator").addEventListener("change", (e) => {
  rt.moderator = (e.target as HTMLSelectElement).value;
  saveRt();
});
$("#rt-add").addEventListener("click", () => {
  const opts = chatWorkerOptions();
  if (!opts.length) return toast("还没有可用模型，先去「模型市场」加一个");
  // Prefer a worker not already chosen, so each added row is visibly different.
  const used = rt.participants.map((p) => p.worker);
  const unused = opts.find((o) => !used.includes(o.value));
  rt.participants.push({ worker: (unused ?? opts[0]).value, skill: "" });
  saveRt();
  renderRtParticipants();
  // Confirm clearly + flash the new row and bring it into view.
  const last = $<HTMLDivElement>("#rt-participants").lastElementChild as HTMLElement | null;
  last?.classList.add("just-added");
  last?.scrollIntoView({ block: "nearest" });
  setTimeout(() => last?.classList.remove("just-added"), 1100);
  toast(`已加入第 ${rt.participants.length} 位参与模型`, "info");
});
$("#mode-code").addEventListener("click", () => {
  mode = "code";
  localStorage.setItem(LS_MODE, mode);
  applyMode();
});
$("#mode-term").addEventListener("click", () => {
  // Already in 终端 → each extra click on the tab adds a column (1 → 2 → 3, capped).
  if (mode === "term") {
    addPaneCapped();
    return;
  }
  mode = "term";
  localStorage.setItem(LS_MODE, mode);
  applyMode();
});
$("#term-skill-close").addEventListener("click", () => termSkillModal.classList.add("hidden"));
$<HTMLInputElement>("#term-skill-search").addEventListener("input", (e) => {
  termSkillSearch = (e.target as HTMLInputElement).value;
  renderTermSkillList();
});

// 协作编程 form fields
$<HTMLInputElement>("#code-dir").addEventListener("input", (e) => {
  code.dir = (e.target as HTMLInputElement).value;
  saveCode();
  validateCodeDir();
});
$<HTMLTextAreaElement>("#code-task").addEventListener("input", (e) => {
  code.task = (e.target as HTMLTextAreaElement).value;
  saveCode();
});
$<HTMLInputElement>("#code-role").addEventListener("input", (e) => {
  code.role = (e.target as HTMLInputElement).value;
  saveCode();
});
$<HTMLInputElement>("#code-auto").addEventListener("change", (e) => {
  code.auto = (e.target as HTMLInputElement).checked;
  saveCode();
});
$<HTMLInputElement>("#code-loop").addEventListener("change", (e) => {
  code.loop = (e.target as HTMLInputElement).checked;
  saveCode();
  if (!code.loop) {
    clearCodeLoop(); // turning it off stops any running 持续协作 timers immediately
    toast("已停止持续协作", "info");
  }
});
$<HTMLInputElement>("#code-loop-mins").addEventListener("change", (e) => {
  const v = parseFloat((e.target as HTMLInputElement).value);
  code.loopMins = isNaN(v) ? 2.5 : Math.min(60, Math.max(0.5, v));
  (e.target as HTMLInputElement).value = String(code.loopMins);
  saveCode();
});
$("#code-add").addEventListener("click", () => {
  const opts = codingAgentOptions();
  if (!opts.length) return toast("没有可用的编程 CLI");
  const used = code.agents.map((a) => a.worker);
  const unused = opts.find((o) => !used.includes(o.value));
  code.agents.push({ worker: (unused ?? opts[0]).value, duty: DUTY_SUGGEST[code.agents.length] ?? "", skills: [] });
  saveCode();
  renderCodeAgents();
  const last = $<HTMLDivElement>("#code-agents").lastElementChild as HTMLElement | null;
  last?.classList.add("just-added");
  last?.scrollIntoView({ block: "nearest" });
  setTimeout(() => last?.classList.remove("just-added"), 1100);
  toast(`已加入第 ${code.agents.length} 个 Agent`, "info");
});
function setCodeDir(p: string) {
  code.dir = p;
  saveCode();
  $<HTMLInputElement>("#code-dir").value = p;
  validateCodeDir();
}
$("#code-pick").addEventListener("click", async () => {
  try {
    const p = await invoke<string | null>("pick_folder");
    if (p) setCodeDir(p);
  } catch (e) {
    toast("打开文件夹失败：" + (e instanceof Error ? e.message : String(e)));
  }
});
$("#code-new").addEventListener("click", async () => {
  try {
    const p = await invoke<string | null>("new_folder");
    if (p) {
      setCodeDir(p);
      toast("已新建文件夹：" + p, "info");
    }
  } catch (e) {
    toast("新建文件夹失败：" + (e instanceof Error ? e.message : String(e)));
  }
});

// GEO 单篇 form fields
$<HTMLInputElement>("#geo-title").addEventListener("input", (e) => {
  geo.title = (e.target as HTMLInputElement).value;
  saveGeo();
});
$<HTMLTextAreaElement>("#geo-material").addEventListener("input", (e) => {
  geo.material = (e.target as HTMLTextAreaElement).value;
  saveGeo();
});
$<HTMLInputElement>("#geo-source").addEventListener("input", (e) => {
  geo.source = (e.target as HTMLInputElement).value;
  saveGeo();
});
$<HTMLSelectElement>("#geo-image").addEventListener("change", (e) => {
  geo.image = (e.target as HTMLSelectElement).value;
  saveGeo();
});
$<HTMLTextAreaElement>("#geo-route").addEventListener("input", (e) => {
  geo.route = (e.target as HTMLTextAreaElement).value;
  saveGeo();
});
$<HTMLInputElement>("#geo-length").addEventListener("input", (e) => {
  geo.length = parseInt((e.target as HTMLInputElement).value, 10) || 800;
  $("#geo-len-val").textContent = String(geo.length);
  saveGeo();
});
$<HTMLSelectElement>("#geo-worker").addEventListener("change", (e) => {
  geo.worker = (e.target as HTMLSelectElement).value;
  saveGeo();
});
$<HTMLSelectElement>("#geo-skill").addEventListener("change", (e) => {
  geo.skill = (e.target as HTMLSelectElement).value;
  saveGeo();
  renderSkills(); // keep the sidebar highlight in sync with the dropdown
});
$("#geo-param-add").addEventListener("click", () => {
  geo.params.push({ k: "", v: "" });
  saveGeo();
  renderGeoParams();
});
$("#geo-card-add").addEventListener("click", () => {
  geo.cards.push({ place: "", note: "" });
  saveGeo();
  renderGeoCards();
});
$("#open-settings").addEventListener("click", openSettings);
$("#open-market").addEventListener("click", () => {
  renderMarket();
  marketModal.classList.remove("hidden");
});
$("#market-close").addEventListener("click", () => marketModal.classList.add("hidden"));

$("#open-history").addEventListener("click", () => {
  renderHistory();
  historyModal.classList.remove("hidden");
});
$("#history-close").addEventListener("click", () => historyModal.classList.add("hidden"));
$("#history-clear").addEventListener("click", () => {
  history = [];
  historyViewId = null;
  saveHistoryLS();
  renderHistory();
});
$("#history-copy").addEventListener("click", async () => {
  const cur = history.find((h) => h.id === historyViewId);
  if (!cur) return;
  try {
    await navigator.clipboard.writeText(cur.md);
    toast("已复制本条", "info");
  } catch {
    /* clipboard blocked */
  }
});

// ---- 协作编程·历史任务 modal: click a snapshot to reload it into the form ----
const codeHistModal = $<HTMLDivElement>("#code-hist-modal");
function renderCodeHist() {
  const listEl = $<HTMLDivElement>("#code-hist-list");
  listEl.innerHTML = "";
  if (!codeHist.length) {
    const empty = document.createElement("div");
    empty.className = "sidebar-note";
    empty.textContent = "还没有历史任务。在协作编程里点一次「运行」就会自动存一份。";
    listEl.appendChild(empty);
    return;
  }
  for (const t of codeHist) {
    const item = document.createElement("div");
    item.className = "codehist-item";
    const d = new Date(t.at);
    const when = `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const main = document.createElement("div");
    main.className = "ch-main";
    const title = document.createElement("div");
    title.className = "ch-title";
    title.textContent = t.title;
    const meta = document.createElement("div");
    meta.className = "ch-meta";
    const who = t.agents.map((a) => a.worker).join(" · ") || "无 Agent";
    meta.textContent = `${when} · ${shortCwd(t.dir) || t.dir || "无目录"} · ${who}`;
    main.append(title, meta);
    const del = document.createElement("button");
    del.className = "danger mini ch-del";
    del.textContent = "✕";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      codeHist = codeHist.filter((x) => x.id !== t.id);
      saveCodeHist();
      renderCodeHist();
    });
    item.append(main, del);
    item.addEventListener("click", () => {
      // Reload this snapshot into the form (deep-copy agents so edits don't mutate history).
      code = {
        dir: t.dir,
        task: t.task,
        role: t.role,
        agents: JSON.parse(JSON.stringify(t.agents)),
        auto: t.auto,
        loop: t.loop,
        loopMins: t.loopMins ?? 2.5,
      };
      saveCode();
      renderCode();
      codeHistModal.classList.add("hidden");
      toast("已填回：" + t.title, "info");
    });
    listEl.appendChild(item);
  }
}
$("#code-hist-open").addEventListener("click", () => {
  renderCodeHist();
  codeHistModal.classList.remove("hidden");
});
$("#code-hist-close").addEventListener("click", () => codeHistModal.classList.add("hidden"));
$("#code-hist-clear").addEventListener("click", () => {
  codeHist = [];
  saveCodeHist();
  renderCodeHist();
});
codeHistModal.addEventListener("click", (e) => {
  if (e.target === codeHistModal) codeHistModal.classList.add("hidden");
});

$("#wf-save").addEventListener("click", saveWorkflow);
// Two-step (not native confirm(), which is unreliable in the webview) to avoid an
// accidental delete and a silent no-op.
twoStepDelete($<HTMLButtonElement>("#wf-del"), "删除", "确认删除", () => void deleteWorkflow());
$("#wf-new").addEventListener("click", () => {
  steps = [{ title: "步骤 1", worker: "", role: "", prompt: "{{input}}" }];
  inputEl.value = "";
  wfNameEl.value = "";
  localStorage.setItem(LS_INPUT, "");
  saveSteps();
  renderSteps();
});
wfLoadEl.addEventListener("change", () => {
  if (wfLoadEl.value) loadWorkflow(wfLoadEl.value);
});

$("#settings-cancel").addEventListener("click", () => {
  // discard edits by reloading from storage
  providers = load(LS_PROVIDERS, DEFAULT_PROVIDERS);
  clis = load(LS_CLIS, DEFAULT_CLIS);
  videos = load(LS_VIDEOS, DEFAULT_VIDEOS);
  images = load(LS_IMAGES, DEFAULT_IMAGES);
  closeSettings();
});
$("#settings-save").addEventListener("click", () => {
  providers = providers.filter((p) => p.name.trim());
  clis = clis.filter((c) => c.name.trim() && c.program.trim());
  videos = videos.filter((v) => v.name.trim());
  images = images.filter((v) => v.name.trim());
  saveProviders();
  saveClis();
  saveVideos();
  saveImages();
  closeSettings();
  renderSteps();
});
$("#add-provider").addEventListener("click", () => {
  providers.push({ name: "新厂商", endpoint: "", key: "", models: "" });
  renderProviders();
});
$("#add-cli").addEventListener("click", () => {
  clis.push({ name: "新命令", program: "", args: "" });
  renderClis();
});
$("#add-video").addEventListener("click", () => {
  videos.push({ name: "新视频源", endpoint: "", key: "", models: "", resolution: "1080p", ratio: "16:9", duration: "5" });
  renderVideos();
});
$("#add-image").addEventListener("click", () => {
  images.push({ name: "新图片源", endpoint: "", key: "", models: "", size: "1024x1024" });
  renderImages();
});

$("#skill-new").addEventListener("click", () => openSkillEditor(null));
$("#skill-cancel").addEventListener("click", () => skillModal.classList.add("hidden"));

// 技能库大窗
$("#skill-manage").addEventListener("click", openSkillsModal);
$("#skills-close").addEventListener("click", () => skillsModal.classList.add("hidden"));
$("#skl-new").addEventListener("click", () => openSkillEditor(null));
$("#skl-sync").addEventListener("click", () => {
  syncOutput.textContent = "";
  syncModal.classList.remove("hidden");
});
$<HTMLInputElement>("#skl-search").addEventListener("input", (e) => {
  sklSearch = (e.target as HTMLInputElement).value;
  renderSkillsModal();
});
$("#skill-save").addEventListener("click", saveSkill);
resetSkillDel = twoStepDelete($<HTMLButtonElement>("#skill-delete"), "删除", "再点删除", () => {
  if (editingSkill) {
    skillModal.classList.add("hidden");
    void doDeleteSkill(editingSkill);
  }
});
$("#skill-sync").addEventListener("click", () => {
  syncOutput.textContent = "";
  syncModal.classList.remove("hidden");
});
$("#sync-close").addEventListener("click", () => syncModal.classList.add("hidden"));
$("#sync-dl-btn").addEventListener("click", downloadSkills);
$("#sync-up-btn").addEventListener("click", uploadSkills);
const syncFileInput = $<HTMLInputElement>("#sync-file-input");
const syncDirInput = $<HTMLInputElement>("#sync-dir-input");
$("#sync-import-file").addEventListener("click", () => syncFileInput.click());
$("#sync-import-dir").addEventListener("click", () => syncDirInput.click());
syncFileInput.addEventListener("change", async () => {
  await importLocalSkills(syncFileInput.files);
  syncFileInput.value = ""; // allow re-picking the same file
});
syncDirInput.addEventListener("change", async () => {
  await importLocalSkills(syncDirInput.files);
  syncDirInput.value = "";
});

renderSteps();
refreshWorkflowList();
refreshSkills();
applyMode();
