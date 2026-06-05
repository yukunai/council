import { invoke, Channel, convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import {
  parseModels,
  parseArgs,
  fillTemplate,
  stepDeps,
  skillBody,
  cnLen,
  splitGeo,
  extractSvg,
  sanitizeSvg,
  decodeWorker,
} from "./utils";
import { applyI18n, t, tf, getLang, setLang, LANGS, type Lang } from "./i18n";
import { cacheKey, cacheGet, cachePut } from "./cache";

// Surface otherwise-silent runtime errors (incl. init-time) instead of a dead-looking UI.
// Registered first so it catches throws during the rest of module evaluation.
window.addEventListener("error", (e) => {
  const el = document.querySelector(".tagline");
  if (el) el.textContent = tf("err.script", { msg: e.message || t("err.seeConsole") });
});
window.addEventListener("unhandledrejection", (e) => {
  const r = (e as PromiseRejectionEvent).reason;
  const el = document.querySelector(".tagline");
  if (el) el.textContent = tf("err.unhandled", { msg: (r && (r.message || r)) || t("err.seeConsole") });
});

// Mirrors the Rust StreamEvent enum (serde tag = "type", lowercase variants).
type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "video"; url: string }
  | { type: "usage"; prompt: number; completion: number; cached: number }
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
  fallback?: string; // optional backup worker, used only if the primary errors or returns empty
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
// "全部" / "未分类" double as logical category keys (compared against persisted state), so they
// stay Chinese internally; this maps just the display label for the current language.
function catLabel(c: string): string {
  return c === "全部" ? t("cat.all") : c === "未分类" ? t("cat.uncategorized") : c;
}
// Merge over defaults so a geo object persisted by an older build (missing newer
// fields like source/material/image) doesn't blow up on access.
let geo: GeoState = { ...DEFAULT_GEO, ...load(LS_GEO, {}) };
let images: ImageProvider[] = load(LS_IMAGES, DEFAULT_IMAGES);
// Seed the Seedream image model once, so the 图像 mode always has a 📷 real-photo source to pick
// (the user still fills its API key). One-time: if they later delete it, the flag stops re-seeding.
if (images.length === 0 && !localStorage.getItem("council.imgseed")) {
  images = IMAGE_PRESETS.map((p) => ({ ...p }));
  localStorage.setItem(LS_IMAGES, JSON.stringify(images));
  localStorage.setItem("council.imgseed", "1");
}
// Default to the terminal (the first screen). LS_MODE is saved on switch but we deliberately
// do NOT restore it at cold launch — the user always starts on this view.
let mode: string = "term";
if (!["pipe", "geo", "rt", "code", "term", "img"].includes(mode)) mode = "term";

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
  loopMins?: number; // 持续协作: this agent's own 巡检 interval (min); undefined = use global default.
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
const DEFAULT_CODE: CodingState = { dir: "", task: "", role: "", agents: [], auto: true, loop: true, loopMins: 2.5 };
// 持续协作 loop config kept on each agent's Term, so a stopped agent can be re-started later.
interface LoopParams {
  nudge: string;
  minGapMs: number;
  quiet: number;
  userQuiet: number;
}
// Active 持续协作 re-scan timers, each tied to its agent's terminal so we can stop/start one or all.
interface CodeLoop {
  timer: number;
  term: Term;
}
let codeLoops: CodeLoop[] = [];
function termHasLoop(term: Term) {
  return codeLoops.some((l) => l.term === term);
}
// Every agent terminal that was launched with a 持续协作 config this run (running or paused).
function agentTerms(): Term[] {
  const out: Term[] = [];
  for (const p of panes) for (const t of p.tabs) if (t.loopParams && t.sessionId) out.push(t);
  return out;
}
// (Re)start an agent's loop from its stored config. No-op if already looping or no config.
function startAgentLoop(term: Term) {
  const p = term.loopParams;
  if (!p || !term.sessionId || termHasLoop(term)) return;
  let lastFire = Date.now() - p.minGapMs; // "due" right away → fires at the next idle window
  const timer = window.setInterval(() => {
    if (!term.sessionId) {
      clearInterval(timer);
      codeLoops = codeLoops.filter((l) => l.timer !== timer);
      term.pane.renderTabs();
      refreshTermToolbar();
      return;
    }
    const now = Date.now();
    if (now - lastFire < p.minGapMs) return; // respect the chosen interval
    if (now - term.lastOutputAt < p.quiet) return; // still working — wait for it to go quiet
    if (now - term.lastInputAt < p.userQuiet) return; // you're typing — don't interrupt
    lastFire = now;
    const sid = term.sessionId;
    // Type the text, then send Enter as a SEPARATE write — a trailing \r in the same chunk gets
    // absorbed by the TUI's paste handling and the line just sits there unsent.
    invoke("write_pty", { id: sid, data: p.nudge }).catch(() => {});
    setTimeout(() => term.sessionId === sid && invoke("write_pty", { id: sid, data: "\r" }).catch(() => {}), 350);
  }, 10000);
  codeLoops.push({ timer, term });
  term.pane.renderTabs();
  refreshTermToolbar();
}
// 停止某个 AI：清掉它的持续协作循环（不再自动催）+ 发 Esc 中断当前正在做的这一轮（config 留着可再开启）。
function stopAgentWork(term: Term) {
  codeLoops.filter((l) => l.term === term).forEach((l) => clearInterval(l.timer));
  codeLoops = codeLoops.filter((l) => l.term !== term);
  if (term.sessionId) invoke("write_pty", { id: term.sessionId, data: "\x1b" }).catch(() => {});
  term.pane.renderTabs();
  refreshTermToolbar();
}
function clearCodeLoop() {
  codeLoops.forEach((l) => clearInterval(l.timer));
  codeLoops = [];
  refreshTermToolbar();
}
// 一键全部停止 / 全部开启。
function stopAllAgentsWork() {
  agentTerms().forEach((t) => stopAgentWork(t));
}
function startAllAgentsWork() {
  agentTerms().forEach((t) => startAgentLoop(t));
}
// Show the 终端 toolbar (全部停止/开启) only when there are 协作编程 agents around.
function refreshTermToolbar() {
  const bar = document.getElementById("term-toolbar");
  if (bar) bar.classList.toggle("hidden", agentTerms().length === 0);
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
  const title = (code.task.trim().split("\n").find((l) => l.trim()) || code.dir.trim() || t("ch.untitledTask")).slice(0, 50);
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
// Maps a run's mode to its i18n key (resolved via t() at display time in the history list).
const MODE_LABEL: Record<string, string> = { pipe: "mode.pipe", geo: "mode.geo", rt: "mode.rt", code: "mode.code" };
function pushHistory(mode: string, title: string, md: string) {
  if (!md.trim()) return;
  history.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    time: Date.now(),
    mode,
    title: title.trim().slice(0, 60) || t("hist.untitled"),
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

// "复用缓存" toggle: when on (default), an unchanged HTTP model step reuses its cached output
// instead of re-billing the model. Off still writes fresh results to the cache, so flipping it
// off is the way to force-regenerate a step whose cached output you didn't like.
const LS_REUSE_CACHE = "council.reusecache";
const reuseCacheEl = $<HTMLInputElement>("#reuse-cache");
reuseCacheEl.checked = localStorage.getItem(LS_REUSE_CACHE) !== "0";
reuseCacheEl.addEventListener("change", () =>
  localStorage.setItem(LS_REUSE_CACHE, reuseCacheEl.checked ? "1" : "0"),
);
const reuseCache = (): boolean => reuseCacheEl.checked;
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
    if (s.fallback && !valid.has(s.fallback)) {
      s.fallback = undefined;
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
    title.placeholder = t("step.titlePh");
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
    del.title = t("step.delTitle");
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
    skillLabel.textContent = t("nav.skills");
    const skill = document.createElement("select");
    skill.className = "col";
    fillSelect(skill, skills.map((s) => ({ value: s.name, label: s.name })), step.skill ?? "", {
      none: t("sel.noSkill"),
    });
    skill.addEventListener("change", () => {
      step.skill = skill.value || undefined;
      saveSteps();
    });
    skillRow.append(skillLabel, skill);

    // optional fallback worker — kicks in only if the primary errors or returns empty
    const fbRow = document.createElement("div");
    fbRow.className = "step-row";
    const fbLabel = document.createElement("span");
    fbLabel.className = "wfbar-label";
    fbLabel.textContent = t("step.fallback");
    fbLabel.title = t("step.fallbackTitle");
    const fb = document.createElement("select");
    fb.className = "col";
    fb.title = t("step.fallbackTitle");
    fillSelect(fb, opts, step.fallback ?? "", { none: t("step.noFallback") });
    fb.addEventListener("change", () => {
      step.fallback = fb.value || undefined;
      saveSteps();
    });
    fbRow.append(fbLabel, fb);

    const role = document.createElement("input");
    role.className = "step-role";
    role.value = step.role;
    role.placeholder = t("step.rolePh");
    role.addEventListener("input", () => {
      step.role = role.value;
      saveSteps();
    });

    const prompt = document.createElement("textarea");
    prompt.rows = 4;
    prompt.value = step.prompt;
    prompt.placeholder = t("step.promptPh");
    prompt.addEventListener("input", () => {
      step.prompt = prompt.value;
      saveSteps();
    });

    card.append(head, skillRow, fbRow, role, prompt);
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
  onUsage?: (u: { prompt: number; completion: number; cached: number }) => void,
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
      else if (ev.type === "usage") onUsage?.(ev);
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

    // Prompt-cache contract: the system message goes FIRST and must stay byte-identical across
    // runs of the same step, because DeepSeek/OpenAI automatic prompt caching keys on the longest
    // common input prefix — a stable system prefix is what gets billed at the cheap cache-hit rate
    // (surfaced as 命中% on the card). Never inject per-call dynamic content (timestamps, counters,
    // randomized ordering) into `system`; keep the variable part in the user message.
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

// Compact token count for the per-step readout: 850 → "850", 1234 → "1.2k", 12345 → "12k".
function fmtTok(n: number): string {
  if (n >= 10000) return Math.round(n / 1000) + "k";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}
// Per-step usage line: prompt ↑ / completion ↓, plus the provider context-cache hit rate when any.
function tokMeta(u: { prompt: number; completion: number; cached: number }): string {
  let s = `↑${fmtTok(u.prompt)} ↓${fmtTok(u.completion)}`;
  if (u.cached > 0 && u.prompt > 0) s += " · " + tf("tok.hit", { pct: Math.round((u.cached / u.prompt) * 100) });
  return s;
}

function makeResultCard(
  step: Step,
  n: number,
): { body: HTMLDivElement; setStatus: (s: string, label: string) => void; setMeta: (txt: string) => void } {
  const worker = document.createElement("span");
  worker.className = "result-worker";
  worker.textContent = workerLabel(step.worker) + (step.skill ? ` · ${tf("card.skillTag", { name: step.skill })}` : "");
  const meta = document.createElement("span");
  meta.className = "result-meta";
  const extras: HTMLElement[] = [worker, meta];
  // Sediment a step that worked back into a reusable skill — prefill the editor with this step's
  // instruction so the skill library grows from real successes instead of hand-authoring.
  const instruction = step.role.trim() || step.prompt.trim();
  if (instruction) {
    const save = document.createElement("button");
    save.className = "mini result-act";
    save.textContent = t("card.saveSkill");
    save.title = t("card.saveSkillTitle");
    save.addEventListener("click", () => openSkillEditor(null, { name: step.title.trim(), body: instruction }));
    extras.push(save);
  }
  const { body, setStatus } = cardShell(`${n}. ${step.title || t("card.untitled")}`, { extras });
  return { body, setStatus, setMeta: (txt: string) => (meta.textContent = txt) };
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
  // Run-level tallies: spent = tokens actually billed this run; provCached = the prompt portion
  // the provider served from its own cache (cheap "白嫖"); memoSaved = tokens skipped entirely by
  // step memoization. Incremented from runStep (single-threaded, so plain += is safe).
  const tally = { prompt: 0, completion: 0, provCached: 0, memoSaved: 0 };

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

  // Dependency-aware parallel execution: a step runs as soon as every earlier step it references
  // (via {{prev}} / {{N}}) has finished, so steps that only read {{input}} run concurrently in the
  // first wave. A pure linear chain (each step uses {{prev}}) yields a full dependency chain and
  // therefore stays fully serial — identical to the old behaviour, zero regression.
  const deps = steps.map((s, i) => stepDeps(s.prompt, i));
  // Build every card up front (in step order) so the display order matches the pipeline even when
  // later steps finish first; they sit as 排队中 until their turn.
  const cards = steps.map((s, i) => makeResultCard(s, i + 1));
  cards.forEach((c) => c.setStatus("", t("status.queued")));
  const done = new Array<boolean>(steps.length).fill(false);
  const failed = new Array<boolean>(steps.length).fill(false);

  const runStep = async (i: number) => {
    if (my !== genId) return;
    const step = steps[i];
    const card = cards[i];
    card.setStatus("running", t("status.running"));
    const skillText = step.skill ? bodies[step.skill] ?? "" : "";
    const system = [skillText, step.role].map((x) => x.trim()).filter(Boolean).join("\n\n");
    const prompt = fillTemplate(step.prompt, input, outputs, i);

    // Primary worker, then the optional fallback — the fallback runs only if the primary errors or
    // returns empty output. Each attempt memoizes/meters under its OWN worker key.
    const workers = [step.worker, step.fallback].filter((w): w is string => !!w && !!w.trim());

    for (let attempt = 0; attempt < workers.length; attempt++) {
      const worker = workers[attempt];
      const isFallback = attempt > 0;
      const hasMore = attempt < workers.length - 1;

      // Step memoization: an HTTP model step is a pure function of (worker, system, prompt), so an
      // identical re-run — the common case while iterating a pipeline (tweak step N, the steps
      // before it are unchanged) — reuses the prior output instead of re-billing the model. CLI /
      // video / image workers are side-effectful or non-deterministic and are never cached.
      const cacheable = decodeWorker(worker).kind === "http";
      const key = cacheable ? await cacheKey(worker, system, prompt) : "";
      if (my !== genId) return;
      if (cacheable && reuseCache()) {
        const hit = cacheGet(key);
        if (hit) {
          const tfh = makeTextFlusher(card.body);
          tfh.stream(hit.output);
          tfh.flush();
          outputs[i] = hit.output;
          done[i] = true;
          tally.memoSaved += hit.prompt + hit.completion;
          card.setStatus("done", isFallback ? t("status.doneFallback") : t("status.cached"));
          card.setMeta(tf("cache.saved", { n: fmtTok(hit.prompt + hit.completion) }));
          scheduleScroll();
          return;
        }
      }

      let acc = "";
      let videoUrl = "";
      // Holder (not a bare `let`) so TS keeps the assigned-in-callback value typed instead of
      // pinning it to the null initializer.
      const usage: { v: { prompt: number; completion: number; cached: number } | null } = { v: null };
      const textFlush = makeTextFlusher(card.body);
      try {
        await runWorker(
          worker,
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
            link.textContent = t("video.link");
            card.body.append(video, link);
            scheduleScroll();
          },
          undefined,
          (u) => {
            usage.v = u;
          },
        );
        textFlush.flush();
        // Stop pressed mid-stream: finalize with the partial output, never fall back.
        if (my !== genId) {
          outputs[i] = videoUrl || acc;
          done[i] = true;
          card.setStatus("done", t("status.stopped"));
          return;
        }
        const out = videoUrl || acc;
        // Empty output with a fallback still to try → treat like a failure and fall back.
        if (!out.trim() && hasMore) {
          card.body.innerHTML = "";
          continue;
        }
        // downstream steps can reference the video URL via {{prev}} / {{N}}
        outputs[i] = out;
        done[i] = true;
        card.setStatus("done", isFallback ? t("status.doneFallback") : t("status.done"));
        const u = usage.v;
        if (u) {
          card.setMeta(tokMeta(u));
          tally.prompt += u.prompt;
          tally.completion += u.completion;
          tally.provCached += u.cached;
        }
        // Memoize the fresh result so the next identical run is free.
        if (cacheable && acc.trim() && u && my === genId) cachePut(key, { output: acc, ...u });
        return;
      } catch (e) {
        textFlush.cancel();
        if (my !== genId) return;
        // Error with a fallback still to try → reset the card and fall back.
        if (hasMore) {
          card.body.innerHTML = "";
          card.body.classList.remove("error");
          continue;
        }
        failed[i] = true;
        card.body.classList.add("error");
        card.body.textContent = e instanceof Error ? e.message : String(e);
        card.setStatus("error", t("status.error"));
        return;
      }
    }
  };

  // A step whose upstream failed/was skipped can never get its input — skip it (transitively),
  // but independent branches keep running (the old code aborted the whole pipeline on first error).
  const propagateSkips = () => {
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < steps.length; i++) {
        if (done[i] || failed[i]) continue;
        if (deps[i].some((d) => failed[d])) {
          failed[i] = true;
          cards[i].setStatus("error", t("status.upstreamSkipped"));
          changed = true;
        }
      }
    }
  };

  // Run wave by wave: each wave = every not-yet-run step whose deps are all done.
  while (my === genId) {
    propagateSkips();
    const ready: number[] = [];
    for (let i = 0; i < steps.length; i++) {
      if (done[i] || failed[i]) continue;
      if (deps[i].every((d) => done[d])) ready.push(i);
    }
    if (!ready.length) break;
    await Promise.all(ready.map((i) => runStep(i)));
  }

  // Run-level token summary — makes provider cache hits (白嫖) and memoization savings visible.
  let summaryText = "";
  if (tally.prompt || tally.completion || tally.memoSaved) {
    const parts = [tf("run.tok", { in: fmtTok(tally.prompt), out: fmtTok(tally.completion) })];
    if (tally.provCached > 0) parts.push(tf("run.cached", { n: fmtTok(tally.provCached) }));
    if (tally.memoSaved > 0) parts.push(tf("run.saved", { n: fmtTok(tally.memoSaved) }));
    summaryText = parts.join(" · ");
    if (my === genId) {
      const summary = document.createElement("div");
      summary.className = "run-summary";
      summary.textContent = summaryText;
      resultsEl.appendChild(summary);
      scheduleScroll();
    }
  }

  if (my === genId && outputs.some((o) => o && o.trim())) {
    const md =
      `# 流水线\n\n**输入**\n\n${input || "(空)"}\n` +
      steps.map((s, i) => `\n\n## ${i + 1}. ${s.title || "(未命名)"}\n\n${outputs[i] ?? ""}`).join("") +
      (summaryText ? `\n\n---\n\n${summaryText}` : "");
    pushHistory("pipe", input.slice(0, 40) || steps[0]?.title || t("mode.pipe"), md);
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
  del.textContent = t("wf.del");
  del.addEventListener("click", onDelete);
  row.append(fieldCol(t("field.name"), name, onName, { col: true }), del);
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
    testBtn.textContent = t("set.testConn");
    testBtn.addEventListener("click", () => testProvider(p, testStatus));
    box.append(
      settingsHead(p.name, (v) => (p.name = v), () => {
        providers.splice(i, 1);
        renderProviders();
      }),
      fieldCol(t("field.endpointChat"), p.endpoint, (v) => (p.endpoint = v), {
        placeholder: "https://api.deepseek.com/chat/completions",
      }),
      fieldCol("API Key", p.key, (v) => (p.key = v), { type: "password", placeholder: "sk-…" }),
      fieldCol(t("field.modelsMulti"), p.models, (v) => (p.models = v), { rows: 3 }),
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
    testBtn.textContent = t("set.testRun");
    testBtn.addEventListener("click", () => testCli(c, testStatus));
    box.append(
      settingsHead(c.name, (v) => (c.name = v), () => {
        clis.splice(i, 1);
        renderClis();
      }),
      fieldCol(t("field.program"), c.program, (v) => (c.program = v), { placeholder: "claude" }),
      fieldCol(t("field.fixedArgs"), c.args, (v) => (c.args = v), { placeholder: "-p" }),
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
      fieldCol(t("field.taskEndpoint"), v.endpoint, (s) => (v.endpoint = s), {
        placeholder: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      }),
      fieldCol("API Key", v.key, (s) => (v.key = s), { type: "password" }),
      fieldCol(t("field.modelsMulti"), v.models, (s) => (v.models = s), { rows: 2 }),
      fieldRow(
        fieldCol(t("field.resolution"), v.resolution, (s) => (v.resolution = s), { placeholder: "1080p", col: true }),
        fieldCol(t("field.ratio"), v.ratio, (s) => (v.ratio = s), { placeholder: "16:9", col: true }),
        fieldCol(t("field.duration"), v.duration, (s) => (v.duration = s), { placeholder: "5", col: true }),
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
      fieldCol(t("field.endpointImg"), v.endpoint, (s) => (v.endpoint = s), {
        placeholder: "https://ark.cn-beijing.volces.com/api/v3/images/generations",
      }),
      fieldCol("API Key", v.key, (s) => (v.key = s), { type: "password" }),
      fieldCol(t("field.modelsMulti"), v.models, (s) => (v.models = s), { rows: 2 }),
      fieldCol(t("field.size"), v.size, (s) => (v.size = s), { placeholder: "1024x1024" }),
    );
    imagesList.appendChild(box);
  });
}

// ---- connection tests ----
function testProvider(p: Provider, statusEl: HTMLElement) {
  const model = parseModels(p.models)[0];
  if (!p.endpoint.trim()) return setTest(statusEl, "error", t("test.noEndpoint"));
  if (!p.key.trim()) return setTest(statusEl, "error", t("test.noKey"));
  if (!model) return setTest(statusEl, "error", t("test.noModel"));

  setTest(statusEl, "running", t("test.testing"));
  let got = false;
  const channel = new Channel<StreamEvent>();
  channel.onmessage = (ev) => {
    if (ev.type === "delta") got = true;
    else if (ev.type === "done")
      setTest(statusEl, "ok", got ? tf("test.okModel", { model }) : t("test.okNoContent"));
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
  if (!c.program.trim()) return setTest(statusEl, "error", t("test.noProgram"));
  setTest(statusEl, "running", t("status.running"));
  let got = false;
  const channel = new Channel<StreamEvent>();
  channel.onmessage = (ev) => {
    if (ev.type === "delta") got = true;
    else if (ev.type === "done") setTest(statusEl, "ok", got ? t("test.cliOk") : t("test.cliOkNoOut"));
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
    add.textContent = t("market.unavailable");
    add.disabled = true;
  } else if (opts.already) {
    add.textContent = t("market.added");
    add.disabled = true;
  } else {
    add.textContent = t("market.add");
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
        { text: preset.models ? tf("market.models", { list: parseModels(preset.models).join("、") }) : "", cls: "market-models" },
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
        { text: `${preset.program} ${preset.args} ${t("market.cmdPlaceholder")}`.trim(), cls: "market-ep" },
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
          text: `${tf("market.models", { list: parseModels(preset.models).join("、") })} · ${preset.resolution} ${preset.ratio} ${preset.duration}s`,
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
        { text: `${tf("market.models", { list: parseModels(preset.models).join("、") })} · ${preset.size}`, cls: "market-models" },
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
    empty.textContent = t("skills.empty");
    skillsListEl.appendChild(empty);
    return;
  }
  const note = document.createElement("div");
  note.className = "sidebar-note";
  note.textContent = t("skills.checkNote");
  skillsListEl.appendChild(note);

  // Category filter tags (dynamic: 全部 + whatever categories exist + 未分类 if any).
  const cats = ["全部", ...allCategories(), ...(skills.some((s) => !s.category.trim()) ? ["未分类"] : [])];
  if (!cats.includes(sidebarCat)) sidebarCat = "全部";
  const catRow = document.createElement("div");
  catRow.className = "skill-cats";
  for (const c of cats) {
    const chip = document.createElement("button");
    chip.className = "skill-cat-chip" + (c === sidebarCat ? " active" : "");
    chip.textContent = catLabel(c);
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
    cb.title = t("skill.checkTitle");
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
    desc.textContent = s.description || t("skill.noDesc");
    txt.append(name, desc);
    txt.addEventListener("click", () => openSkillEditor(s.name));

    const edit = document.createElement("button");
    edit.className = "skill-edit mini";
    edit.textContent = "✎";
    edit.title = t("skill.editTitle");
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
// `prefill` (only meaningful when name === null) seeds a brand-new skill from an existing source —
// e.g. a pipeline step that worked, sedimented into a reusable skill.
async function openSkillEditor(
  name: string | null,
  prefill?: { name?: string; description?: string; body?: string },
) {
  resetSkillDel();
  editingSkill = name;
  $("#skill-modal-title").textContent = name ? t("skill.editTitle2") : t("skill.newTitle");
  const nameEl = $<HTMLInputElement>("#skill-name");
  const descEl = $<HTMLInputElement>("#skill-desc");
  const catEl = $<HTMLInputElement>("#skill-category");
  const bodyEl = $<HTMLTextAreaElement>("#skill-body");
  const delBtn = $<HTMLButtonElement>("#skill-delete");
  // Category suggestions (used + user-created); typing a new one also creates that category.
  $<HTMLDataListElement>("#skill-cat-list").innerHTML = allCategories()
    .map((c) => `<option value="${escHtml(c)}"></option>`)
    .join("");
  nameEl.value = name ?? prefill?.name ?? "";
  descEl.value = prefill?.description ?? "";
  catEl.value = "";
  bodyEl.value = prefill?.body ?? "";
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
  if (!name) return toast(t("toast.skillNeedsName"));
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
    toast(tf("toast.saveFailed", { msg: e instanceof Error ? e.message : String(e) }));
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
    toast(tf("toast.deleteFailed", { msg: e instanceof Error ? e.message : String(e) }));
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
        syncOutput.textContent += "\n✓ " + t("status.done") + "\n";
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
  if (!url) return toast(t("toast.fillRepoUrl"));
  syncOutput.textContent = t("sync.cloning") + "\n";
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
  if (!url) return toast(t("toast.fillUploadUrl"));
  syncOutput.textContent = t("sync.uploading") + "\n";
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
    syncOutput.textContent = t("sync.noMd") + "\n";
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
  syncOutput.textContent += `\n${tf("sync.imported", { ok, total: list.length })}\n`;
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
  fillSelect(wfLoadEl, names.map((n) => ({ value: n, label: n })), "", { none: t("wf.loadPh") });
}

async function saveWorkflow() {
  const name = wfNameEl.value.trim();
  if (!name) {
    toast(t("toast.nameWorkflow"));
    return;
  }
  const content = JSON.stringify({ input: inputEl.value, steps }, null, 2);
  try {
    const path = await invoke<string>("save_workflow", { name, content });
    await refreshWorkflowList();
    wfLoadEl.value = name;
    flash(tf("flash.savedTo", { path }));
  } catch (e) {
    toast(tf("toast.saveFailed", { msg: e instanceof Error ? e.message : String(e) }));
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
    toast(tf("toast.loadFailed", { msg: e instanceof Error ? e.message : String(e) }));
  }
}

async function deleteWorkflow() {
  const name = wfNameEl.value.trim();
  if (!name) return toast(t("toast.selectWorkflow"));
  try {
    await invoke("delete_workflow", { name });
    await refreshWorkflowList();
    wfNameEl.value = "";
    wfLoadEl.value = "";
    flash(tf("flash.deleted", { name }));
  } catch (e) {
    toast(tf("toast.deleteFailed", { msg: e instanceof Error ? e.message : String(e) }));
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
    // Display the localized name/hint; s.label/s.hint stay Chinese for the model brief (buildGeoBrief).
    b.textContent = t("geostyle." + s.key);
    b.title = t("geostyle." + s.key + ".hint");
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
    k.placeholder = t("geo.paramKeyPh");
    k.value = p.k;
    k.addEventListener("input", () => {
      p.k = k.value;
      saveGeo();
    });
    const v = document.createElement("input");
    v.placeholder = t("geo.paramValPh");
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
    num.textContent = tf("geo.cardNum", { n: i + 1 });
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
    place.placeholder = t("geo.placePh");
    place.value = c.place;
    place.addEventListener("input", () => {
      c.place = place.value;
      saveGeo();
    });
    const note = document.createElement("textarea");
    note.rows = 2;
    note.placeholder = t("geo.cardNotePh");
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
    none: t("geo.skillNone"),
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
  fillSelect(im, imgOpts, geo.image, { none: t("geo.imageNone") });
  if (changed) saveGeo();
}

function renderGeo() {
  $<HTMLInputElement>("#geo-title").value = geo.title;
  $<HTMLTextAreaElement>("#geo-material").value = geo.material;
  $<HTMLInputElement>("#geo-source").value = geo.source;
  $<HTMLTextAreaElement>("#geo-route").value = geo.route;
  $<HTMLInputElement>("#geo-length").value = String(geo.length);
  $("#geo-len-label").textContent = tf("geo.lenLabel", { n: geo.length });
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
  copy.textContent = t("btn.copy");
  const { body, setStatus } = cardShell(title, { extras: [copy] });

  let getText = () => body.textContent ?? "";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(getText());
      copy.textContent = t("btn.copied");
      setTimeout(() => (copy.textContent = t("btn.copy")), 1200);
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
    card.setStatus(
      "running",
      acc ? tf("sc.statusChars", { verb, n: cnLen(acc), s }) : tf("sc.statusTime", { verb, s }),
    );
  };
  status();
  card.streamText(t("sc.waiting"));
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
      tf("sc.errorPrefix", { msg: e instanceof Error ? e.message : String(e) }) +
        (skippable ? t("sc.skippedNote") : ""),
    );
    card.setStatus("error", skippable ? t("sc.errorSkipped") : t("status.error"));
    return null;
  }
  clearInterval(timer);
  if (my !== genId) return null;
  const text = acc.trim();
  card.setEditable(text);
  card.setStatus("done", tf("sc.chars", { n: cnLen(text) }));
  return { text, getText: card.getText };
}

// extractSvg / sanitizeSvg now imported from ./utils (pure + tested)

// ---- 图像 mode (text-to-image / image-to-image) state ----
interface DrawState {
  prompt: string;
  worker: string; // "img::<provider>::<model>" (HTTP raster) or "cli::<name>" (CLI → SVG)
  ratio: string; // one of IMG_RATIOS keys
  n: number; // 1..4 images per run (generated by N parallel calls)
  type: string; // one of IMG_TYPES keys — prepends a prompt fragment
  style: string; // one of IMG_STYLES keys — prepends an art-style fragment
  skill: string; // attached SKILL.md name (its body prepends to the prompt), or ""
}
const LS_DRAW = "council.draw";
const DEFAULT_DRAW: DrawState = { prompt: "", worker: "", ratio: "1:1", n: 1, type: "none", style: "none", skill: "" };
let draw: DrawState = { ...DEFAULT_DRAW, ...load(LS_DRAW, {}) };
function saveDraw() {
  localStorage.setItem(LS_DRAW, JSON.stringify(draw));
}
let drawRef = ""; // reference image (data URL) for image-to-image — transient, not persisted
// Aspect ratio → pixel size (Seedream-friendly; OpenAI accepts its own sizes via the same field).
const IMG_RATIOS: { key: string; size: string }[] = [
  { key: "1:1", size: "1024x1024" },
  { key: "21:9", size: "1512x648" },
  { key: "16:9", size: "1280x720" },
  { key: "9:16", size: "720x1280" },
  { key: "3:4", size: "864x1152" },
];
// Image sources: local CLIs (→ SVG) + HTTP image providers (→ raster). Shared by GEO + 图像.
// Both kinds make REAL images now: 🤖 CLI agents (grok / codex have built-in image tools, use
// their own auth, no extra key) and 📷 HTTP image models (need an API key). CLIs are listed first
// since they work out of the box for users who already have those CLIs.
function imageSourceOptions(): { value: string; label: string }[] {
  const opts: { value: string; label: string }[] = [];
  for (const c of clis) opts.push({ value: `cli::${c.name}`, label: `🤖 ${c.name}` });
  for (const p of images) for (const m of parseModels(p.models)) opts.push({ value: `img::${p.name}::${m}`, label: `📷 ${p.name} · ${m}` });
  return opts;
}
// Confirmed-working headless image invocations per CLI binary (prompt appended last by the backend).
// grok & codex generate real images via their own tools; gemini/claude here have no image tool.
const IMG_CLI_INVOKE: Record<string, string[]> = {
  grok: ["--always-approve", "-p"],
  codex: ["exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"],
  gemini: ["-y", "--skip-trust", "-p"],
  claude: ["--dangerously-skip-permissions", "-p"],
  "cursor-agent": ["--force", "-p"],
};
// Image type presets — chips that prepend a Chinese prompt fragment (sent to the model) to shape
// the result. The chip LABEL is localized via t("imgtype.<key>"); the hint stays Chinese.
const IMG_TYPES: { key: string; hint: string }[] = [
  { key: "none", hint: "" },
  { key: "portrait", hint: "人像摄影，自然光，浅景深，细节清晰、真实" },
  { key: "landscape", hint: "风光摄影，广角，自然光，层次丰富、真实" },
  { key: "product", hint: "商品摄影，纯色干净背景，棚拍柔光，质感清晰、电商主图" },
  { key: "poster", hint: "海报设计，构图有视觉冲击，留出标题文字区，配色协调" },
  { key: "illustration", hint: "插画风格，干净线条，和谐配色" },
  { key: "logo", hint: "简洁的 Logo / 图标设计，矢量感，纯色背景，居中构图" },
  { key: "sticker", hint: "可爱表情贴纸风格，简洁，白色或透明背景，留白" },
];
// Art-style presets — same idea as types: localized chip label + a Chinese prompt fragment.
const IMG_STYLES: { key: string; hint: string }[] = [
  { key: "none", hint: "" },
  { key: "real", hint: "写实照片风格，真实质感，高细节，自然光" },
  { key: "anime", hint: "日系动漫风格，精致线条，鲜明色彩" },
  { key: "ghibli", hint: "吉卜力动画风格，手绘质感，温暖柔和的色调" },
  { key: "cyberpunk", hint: "赛博朋克风格，霓虹灯光，未来都市，高对比" },
  { key: "watercolor", hint: "水彩画风格，柔和晕染，清新淡雅" },
  { key: "oil", hint: "油画风格，厚重笔触，丰富层次" },
  { key: "render3d", hint: "3D 渲染风格，立体光影，精致材质" },
  { key: "flat", hint: "扁平插画风格，简洁几何，明快配色" },
  { key: "pixel", hint: "像素风格，复古 8-bit，颗粒分明" },
  { key: "ink", hint: "中国水墨国风，留白写意，毛笔笔触" },
];

type ImgResult = { kind: "svg" | "url" | "err"; data: string };

async function generateCliImages(
  desc: string,
  worker: string,
  opts: { size?: string } = {},
  count = 1,
): Promise<ImgResult[]> {
  const name = worker.slice(5);
  const c = clis.find((x) => x.name === name);
  if (!c) return [{ kind: "err", data: tf("img.cliNotFound", { name }) }];
  const n = Math.max(1, Math.min(4, Math.floor(count)));
  const ratio = opts.size ? ` Aspect/size target: ${opts.size}.` : "";
  const fileRule =
    n === 1
      ? "Save exactly one real PNG or JPG in the current directory."
      : `Save exactly ${n} distinct real PNG or JPG files in the current directory, named council-1.png through council-${n}.png if possible.`;
  const p = `${fileRule} Do not create SVG, code, markdown, or text-only descriptions.${ratio} Prompt: ${desc}. When finished, output only DONE.`;
  const inv = IMG_CLI_INVOKE[c.program] ?? parseArgs(c.args);
  try {
    const paths = await invoke<string[]>("cli_gen_images", { program: c.program, args: inv, prompt: p, count: n });
    if (!paths.length) return [{ kind: "err", data: t("img.cliNoImage") }];
    return paths.slice(0, n).map((path) => ({ kind: "url", data: convertFileSrc(path) }));
  } catch (e) {
    return [{ kind: "err", data: e instanceof Error ? e.message : String(e) }];
  }
}

// Generate one image for `desc`. Reusable across GEO (default worker = geo.image) and the 图像
// mode (explicit worker + size/ratio + optional reference image for image-to-image).
async function generateImage(
  desc: string,
  worker: string = geo.image,
  opts: { size?: string; image?: string; realCli?: boolean } = {},
): Promise<ImgResult> {
  const w = worker;
  if (w.startsWith("cli::")) {
    const name = w.slice(5);
    const c = clis.find((x) => x.name === name);
    if (!c) return { kind: "err", data: tf("img.cliNotFound", { name }) };
    // 图像 mode: let the CLI agent generate + save a REAL image file, then read it back.
    if (opts.realCli) {
      const [res] = await generateCliImages(desc, w, { size: opts.size }, 1);
      return res ?? { kind: "err", data: t("img.cliNoImage") };
    }
    // GEO default: lightweight SVG via stdout (fast, vector, for article illustrations).
    const ratio = opts.size ? `，画布比例约 ${opts.size.replace("x", "×")} 像素` : "，宽约 800";
    const prompt = `请画一张图，主题：${desc}${ratio}。\n直接把一段完整 SVG 代码打印到标准输出：以 <svg 开头、以 </svg> 结尾，带 viewBox。画面简洁、有信息量，可含图形与少量文字标注。\n不要创建或修改任何文件、不要运行其他命令、不要任何解释、不要 markdown 代码块围栏，只输出 SVG 本身。`;
    let acc = "";
    await runWorker(w, "", prompt, (t) => (acc += t), () => {});
    const svg = extractSvg(acc);
    return svg
      ? { kind: "svg", data: svg }
      : { kind: "err", data: tf("img.noSvg", { head: acc.slice(0, 120) }) };
  }
  if (w.startsWith("img::")) {
    const parts = w.split("::");
    const provider = parts[1] ?? "";
    const model = parts.slice(2).join("::");
    const p = images.find((x) => x.name === provider);
    if (!p) return { kind: "err", data: tf("img.providerNotFound", { provider }) };
    if (!p.endpoint.trim() || !p.key.trim())
      return { kind: "err", data: tf("img.missingEndpointKey", { name: p.name }) };
    const url = await invoke<string>("image_generate", {
      endpoint: p.endpoint,
      apiKey: p.key,
      model,
      prompt: desc,
      size: opts.size ?? p.size ?? "",
      image: opts.image && opts.image.trim() ? opts.image : undefined,
    });
    return { kind: "url", data: url };
  }
  return { kind: "err", data: t("img.noSource") };
}

// ---- 图像 mode: form render + run (text-to-image / image-to-image) ----
const imgEditor = $<HTMLElement>("#img-editor");
function renderDraw() {
  $<HTMLTextAreaElement>("#img-prompt").value = draw.prompt;
  const opts = imageSourceOptions();
  if (draw.worker && !opts.some((o) => o.value === draw.worker)) {
    draw.worker = "";
    saveDraw();
  }
  // Default to the first available source (CLIs come first — grok/codex work without an API key).
  if (!draw.worker && opts.length) {
    draw.worker = opts[0].value;
    saveDraw();
  }
  fillSelect($<HTMLSelectElement>("#img-source"), opts, draw.worker, { none: t("img.sourceNone") });
  $("#img-svg-warn").classList.add("hidden"); // CLIs now make real images too — no SVG warning
  // type chips (人像 / 风景 / 商品 / 海报 …) — localized label, Chinese hint shapes the prompt
  const twrap = $<HTMLDivElement>("#img-types");
  twrap.innerHTML = "";
  for (const ty of IMG_TYPES) {
    const b = document.createElement("button");
    b.className = "geo-style-btn" + (ty.key === draw.type ? " active" : "");
    b.textContent = t("imgtype." + ty.key);
    b.addEventListener("click", () => {
      draw.type = ty.key;
      saveDraw();
      renderDraw();
    });
    twrap.appendChild(b);
  }
  // style chips (写实 / 动漫 / 吉卜力 / 赛博朋克 …)
  const swrap = $<HTMLDivElement>("#img-styles");
  swrap.innerHTML = "";
  for (const st of IMG_STYLES) {
    const b = document.createElement("button");
    b.className = "geo-style-btn" + (st.key === draw.style ? " active" : "");
    b.textContent = t("imgstyle." + st.key);
    b.addEventListener("click", () => {
      draw.style = st.key;
      saveDraw();
      renderDraw();
    });
    swrap.appendChild(b);
  }
  // skill select (its body prepends to the prompt)
  draw.skill = skills.some((s) => s.name === draw.skill) ? draw.skill : "";
  fillSelect(
    $<HTMLSelectElement>("#img-skill"),
    skills.map((s) => ({ value: s.name, label: s.name })),
    draw.skill,
    { none: t("sel.noSkill") },
  );
  const chips = (wrap: HTMLElement, items: string[], cur: string, pick: (v: string) => void) => {
    wrap.innerHTML = "";
    for (const v of items) {
      const b = document.createElement("button");
      b.className = "geo-style-btn" + (v === cur ? " active" : "");
      b.textContent = v;
      b.addEventListener("click", () => {
        pick(v);
        saveDraw();
        renderDraw();
      });
      wrap.appendChild(b);
    }
  };
  chips($("#img-ratios"), IMG_RATIOS.map((r) => r.key), draw.ratio, (v) => (draw.ratio = v));
  chips($("#img-counts"), ["1", "2", "3", "4"], String(draw.n), (v) => (draw.n = parseInt(v, 10)));
  const prev = $<HTMLDivElement>("#img-ref-preview");
  prev.innerHTML = "";
  $("#img-ref-clear").classList.toggle("hidden", !drawRef);
  if (drawRef) {
    const im = document.createElement("img");
    im.src = drawRef;
    im.className = "img-ref-thumb";
    prev.appendChild(im);
  }
}

function renderImgResultInto(body: HTMLElement, res: ImgResult) {
  body.innerHTML = "";
  body.classList.remove("error");
  if (res.kind === "err") {
    body.classList.add("error");
    body.textContent = res.data;
    return;
  }
  if (res.kind === "svg") {
    const box = document.createElement("div");
    box.className = "img-out";
    box.innerHTML = sanitizeSvg(res.data);
    body.appendChild(box);
    const a = document.createElement("a");
    a.className = "result-link";
    a.textContent = t("img.download");
    a.href = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(res.data);
    a.download = "council-image.svg";
    body.appendChild(a);
    return;
  }
  const im = document.createElement("img");
  im.className = "img-out";
  im.src = res.data;
  body.appendChild(im);
  const a = document.createElement("a");
  a.className = "result-link";
  a.textContent = t("img.download");
  a.href = res.data;
  a.target = "_blank";
  a.download = "council-image.png";
  body.appendChild(a);
}

async function runDraw() {
  if (running) return;
  if (!draw.prompt.trim()) return toast(t("toast.fillImgPrompt"));
  if (!draw.worker) return toast(t("toast.pickImgSource"));
  const ratio = IMG_RATIOS.find((r) => r.key === draw.ratio) ?? IMG_RATIOS[0];
  const isCli = draw.worker.startsWith("cli::");
  if (drawRef && isCli) toast(t("toast.cliNoI2i"), "info"); // CLI can't do img2img — ref ignored
  // Build the final prompt: attached skill body + type-preset fragment + the user's description.
  let skillText = "";
  if (draw.skill) {
    try {
      skillText = skillBody(await invoke<string>("read_skill", { name: draw.skill }));
    } catch {
      skillText = "";
    }
  }
  const typeHint = IMG_TYPES.find((ty) => ty.key === draw.type)?.hint || "";
  const styleHint = IMG_STYLES.find((st) => st.key === draw.style)?.hint || "";
  const fullPrompt = [skillText.trim(), typeHint, styleHint, draw.prompt.trim()].filter(Boolean).join("\n");
  const my = beginRun();
  try {
    resultsEl.innerHTML = "";
    const n = Math.max(1, Math.min(4, draw.n));
    const cards = Array.from({ length: n }, (_, i) => {
      const c = cardShell(tf("img.cardTitle", { i: i + 1 }));
      c.setStatus("running", t("img.generating"));
      return c;
    });
    if (isCli) {
      const res = await generateCliImages(fullPrompt, draw.worker, { size: ratio.size }, n);
      if (my !== genId) return;
      cards.forEach((card, i) => {
        const r = res[i] ?? { kind: "err", data: t("img.cliNoImage") };
        renderImgResultInto(card.body, r);
        card.setStatus(r.kind === "err" ? "error" : "done", r.kind === "err" ? t("status.error") : t("status.done"));
      });
      return;
    }
    await Promise.all(
      cards.map(async (card, i) => {
        if (my !== genId) return;
        try {
          const res = await generateImage(fullPrompt, draw.worker, {
            size: ratio.size,
            image: isCli ? undefined : drawRef || undefined,
            realCli: true, // 图像 mode: CLI agents produce real image files, not SVG
          });
          if (my !== genId) return;
          renderImgResultInto(card.body, res);
          card.setStatus(res.kind === "err" ? "error" : "done", res.kind === "err" ? t("status.error") : t("status.done"));
        } catch (e) {
          if (my !== genId) return;
          card.body.classList.add("error");
          card.body.textContent = e instanceof Error ? e.message : String(e);
          card.setStatus("error", t("status.error"));
        }
        void i;
      }),
    );
  } finally {
    endRun(my);
  }
}

// One image slot in the gallery: shows 生成中 / image / error+retry, independently.
interface ImgSlot {
  pending: () => void;
  fill: (r: ImgResult, onRetry: () => void) => void;
}
function makeImageGallery() {
  const { body, setStatus } = cardShell(t("img.galleryTitle"));
  return {
    addSlot: (n: number, desc: string): ImgSlot => {
      const fig = document.createElement("figure");
      fig.className = "geo-figure";
      const holder = document.createElement("div");
      const cap = document.createElement("figcaption");
      cap.className = "geo-cap";
      cap.textContent = tf("img.caption", { n, desc });
      fig.append(holder, cap);
      body.appendChild(fig);

      const pending = () => {
        holder.className = "geo-cap";
        holder.textContent = tf("img.generating", { n });
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
          link.textContent = t("img.imgLink");
          holder.append(img, link);
        } else {
          const er = document.createElement("div");
          er.className = "result-body error";
          er.textContent = tf("img.failed", { n, data: r.data });
          const retry = document.createElement("button");
          retry.className = "mini";
          retry.textContent = t("img.retry");
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
  copy.textContent = t("export.copyAll");
  const md = document.createElement("button");
  md.className = "mini primary";
  md.textContent = t("export.md");
  const txt = document.createElement("button");
  txt.className = "mini";
  txt.textContent = t("export.txt");
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
    setStatus("done", t("export.exported"));
    setTimeout(() => setStatus("done", ""), 1500);
  };

  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(buildMarkdown());
      copy.textContent = t("btn.copied");
      setTimeout(() => (copy.textContent = t("export.copyAll")), 1200);
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
    toast(t("toast.pickModel"));
    return;
  }
  const hasContent =
    geo.title.trim() ||
    geo.material.trim() ||
    geo.source.trim() ||
    geo.route.trim() ||
    geo.cards.some((c) => c.place.trim() || c.note.trim());
  if (!hasContent) {
    toast(t("toast.geoNeedContent"));
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

    card = makeGeoResultCard(t("geo.bodyCardTitle"));
    card.setStatus("running", geo.source.trim() ? t("geo.readingLink") : t("geo.generating"));

    // If a source URL was given, fetch its text and rewrite from it.
    let brief = buildGeoBrief();
    if (geo.source.trim()) {
      try {
        const fetched = await invoke<string>("fetch_url", { url: geo.source.trim() });
        if (my !== genId) return;
        brief += `\n\n以下是参考链接的正文内容，请基于它改写成上面要求的文章（保留事实信息，重组结构、换表达、按 GEO 规则成文，不要逐句照抄）：\n"""\n${fetched.slice(0, 12000)}\n"""`;
        card.setStatus("running", t("geo.generating"));
      } catch (e) {
        if (my !== genId) return;
        card.setError(tf("geo.readLinkFailed", { msg: e instanceof Error ? e.message : String(e) }));
        card.setStatus("error", t("status.error"));
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
        card!.setStatus("running", tf("geo.generatingChars", { n: cnLen(acc) }));
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
    card.setStatus("done", tf("geo.doneChars", { n: cnLen(cleaned), target: geo.length }));
    let tweetCard: ReturnType<typeof makeGeoResultCard> | null = null;
    if (tweet) {
      tweetCard = makeGeoResultCard(t("geo.tweetCardTitle"));
      tweetCard.setEditable(tweet);
      tweetCard.setStatus("done", tf("sc.chars", { n: cnLen(tweet) }));
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
    makeExportToolbar(t("export.wholeArticle"), titleHint, buildMarkdown, buildText);
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
        gal.setStatus("running", tf("img.parallelGen", { n: markers.length }));
        await Promise.all(markers.map((_, i) => genInto(i)));
      } else {
        for (let i = 0; i < markers.length; i++) {
          if (my !== genId) return;
          gal.setStatus("running", tf("img.progress", { i: i + 1, total: markers.length }));
          await genInto(i);
        }
      }
      if (my !== genId) return;
      gal.setStatus("done", t("img.galleryDone"));
    }
  } catch (e) {
    if (my === genId && card) {
      card.setError(e instanceof Error ? e.message : String(e));
      card.setStatus("error", t("status.error"));
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
    note.textContent = t("rt.emptyNote");
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
        ? [...opts, { value: p.worker, label: tf("worker.invalid", { label: workerLabel(p.worker) }) }]
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
    lab.textContent = t("nav.skills");
    const ssel = document.createElement("select");
    if (p.skill && !skills.some((s) => s.name === p.skill)) p.skill = ""; // skill was deleted → clear
    fillSelect(ssel, skills.map((s) => ({ value: s.name, label: s.name })), p.skill, { none: t("sel.noSkill") });
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
  $("#rt-rounds-label").textContent = tf("rt.roundsLabel", { n: rt.rounds });
  renderRtParticipants();
  refreshRtSelectors();
}

async function runRoundtable() {
  if (running) return;
  if (!rt.question.trim()) return toast(t("toast.fillQuestion"));
  const valid = new Set(chatWorkerOptions().map((o) => o.value));
  const parts = rt.participants.filter((p) => valid.has(p.worker));
  if (parts.length < 2) return toast(t("toast.rtNeed2"));
  if (!rt.moderator || !valid.has(rt.moderator)) return toast(t("toast.rtNeedModerator"));

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
        const heading = `${tf("rt.roundLabel", { r })} · ${workerLabel(worker)}${skill ? ` · ${tf("card.skillTag", { name: skill })}` : ""}`;
        const res = await contribute(
          heading,
          worker,
          system,
          prompt,
          first ? t("rt.verbDraft") : t("rt.verbImprove"),
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
      toast(t("toast.rtAllFailed"));
      return;
    }
    const tx = transcript
      .map((t) => `【第 ${t.round} 轮 · ${t.label}】\n${t.text.slice(0, 6000)}`)
      .join("\n\n");
    const modPrompt = `问题：\n${Q}\n\n以下是多个模型多轮接力改进的完整记录：\n\n${tx}\n\n请你作为主持人综述，用 Markdown 分三节：\n## 共识\n大家一致认可的结论。\n## 分歧与演变\n观点如何变化、还有哪些不同看法或未解的问题。\n## 最终建议\n综合各方，给出你认为最好的最终答案。`;
    const modHeading = `${t("rt.moderatorHeading")} · ${workerLabel(rt.moderator)}`;
    const modRes = await contribute(
      modHeading,
      rt.moderator,
      "你是这场多模型讨论的主持人，客观中立，善于提炼共识与分歧。",
      modPrompt,
      t("rt.verbSynth"),
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
    makeExportToolbar(t("export.wholeSession"), rt.question.trim() || t("rt.exportTitle"), buildMarkdown, buildText);
    pushHistory("rt", rt.question.trim() || t("rt.exportTitle"), buildMarkdown());
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
  // 协作编程 task snapshots live at the top — clicking one fills the 协作编程 form and jumps there
  // (they have no markdown result, so they don't use the right-hand viewer).
  for (const task of codeHist) {
    const item = document.createElement("div");
    item.className = "history-item";
    const d = new Date(task.at);
    const when = `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const title = document.createElement("span");
    title.className = "h-title";
    title.textContent = task.title;
    const meta = document.createElement("span");
    meta.className = "h-meta";
    meta.textContent = `${t("mode.code")} · ${when}`;
    const del = document.createElement("button");
    del.className = "danger mini h-del";
    del.textContent = "✕";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      codeHist = codeHist.filter((x) => x.id !== task.id);
      saveCodeHist();
      renderHistory();
    });
    item.append(title, meta, del);
    item.addEventListener("click", () => {
      loadCodeTask(task);
      historyModal.classList.add("hidden");
    });
    listEl.appendChild(item);
  }
  if (!history.length && !codeHist.length) {
    const empty = document.createElement("div");
    empty.className = "sidebar-note";
    empty.textContent = t("hist.empty");
    listEl.appendChild(empty);
    viewEl.textContent = "";
    historyViewId = null;
    return;
  }
  if (!history.length) {
    viewEl.textContent = t("hist.codeHint");
    historyViewId = null;
    return;
  }
  if (!historyViewId || !history.some((h) => h.id === historyViewId)) historyViewId = history[0].id;
  for (const h of history) {
    const item = document.createElement("div");
    item.className = "history-item" + (h.id === historyViewId ? " active" : "");
    const d = new Date(h.time);
    const when = `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const title = document.createElement("span");
    title.className = "h-title";
    title.textContent = h.title;
    const meta = document.createElement("span");
    meta.className = "h-meta";
    meta.textContent = `${MODE_LABEL[h.mode] ? t(MODE_LABEL[h.mode]) : h.mode} · ${when}`;
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
    toast(tf("toast.movedTo", { name, cat: category || t("cat.uncategorized") }), "info");
  } catch (e) {
    toast(tf("toast.moveFailed", { msg: e instanceof Error ? e.message : String(e) }));
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
  addInput.placeholder = t("skl.newCatPh");
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
    label.textContent = catLabel(c);
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
      ? t("skl.emptyLib")
      : sklCat !== "全部" && sklCat !== "未分类"
        ? tf("skl.emptyCat", { cat: sklCat })
        : t("skl.noMatch");
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
    edit.title = t("skl.edit");
    edit.addEventListener("click", () => openSkillEditor(s.name));
    const del = document.createElement("button");
    del.className = "skill-edit mini";
    del.textContent = "🗑";
    del.title = t("skl.delTitle");
    twoStepDelete(del, "🗑", t("skl.confirm"), () => void doDeleteSkill(s.name));
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
    desc.textContent = s.description || t("skill.noDesc");
    card.append(desc);

    // Reliable (non-drag) way to move a skill into a category: a dropdown.
    const moveRow = document.createElement("div");
    moveRow.className = "skl-move-row";
    const moveLab = document.createElement("span");
    moveLab.textContent = t("skl.category");
    const move = document.createElement("select");
    move.className = "skl-move";
    move.title = t("skl.moveTo");
    const cur = s.category.trim();
    for (const cat of ["", ...allCategories()]) {
      const o = document.createElement("option");
      o.value = cat;
      o.textContent = cat || t("cat.uncategorized");
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
    note.textContent = t("code.emptyNote");
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
        ? [...opts, { value: a.worker, label: tf("worker.invalid", { label: workerLabel(a.worker) }) }]
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
    duty.placeholder = tf("code.dutyPh", { duty: DUTY_SUGGEST[i] ?? t("code.dutyFallback") });
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
    lab.textContent = t("nav.skills");
    skillRow.appendChild(lab);
    if (!skills.length) {
      const none = document.createElement("span");
      none.className = "chips-empty";
      none.textContent = t("code.skillsEmpty");
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

    // Per-agent 巡检 interval (持续协作). The implementer continues on its own as soon as it goes
    // idle, so it shows a static label; reviewers/testers each set their own minutes, so a
    // downstream agent can scan *after* the upstream one has had time to make changes (not at the
    // same instant, which would make it see "no change" and waste the cycle).
    // Mirror runCoding's role logic exactly (empty duty falls back to DUTY_SUGGEST[i] then "实现"),
    // so the row's label/timing matches how it will actually run.
    const roleForRow = a.duty.trim() || DUTY_SUGGEST[i] || "实现";
    const isImplRow = i === 0 || roleForRow.includes("实现");
    const loopRow = document.createElement("div");
    loopRow.className = "code-agent-loop";
    const llab = document.createElement("span");
    llab.className = "wfbar-label";
    // 实现位：a.loopMins = 写完一步后等多少分钟没人介入再继续（默认 2）。
    // 审查/测试：a.loopMins = 巡检间隔（留空=用下方全局间隔）。
    llab.textContent = isImplRow ? t("code.loopImplPre") : t("code.loopScanPre");
    const mins = document.createElement("input");
    mins.type = "number";
    mins.min = "0.5";
    mins.max = "60";
    mins.step = "0.5";
    mins.className = "code-loop-mins";
    mins.value = a.loopMins != null ? String(a.loopMins) : "";
    mins.placeholder = isImplRow ? "2" : String(code.loopMins || 2.5);
    mins.title = isImplRow ? t("code.loopImplTitle") : t("code.loopScanTitle");
    mins.addEventListener("change", () => {
      const v = parseFloat(mins.value);
      a.loopMins = mins.value.trim() === "" || isNaN(v) ? undefined : Math.min(60, Math.max(0.5, v));
      mins.value = a.loopMins != null ? String(a.loopMins) : "";
      saveCode();
    });
    const unit = document.createElement("span");
    unit.className = "wfbar-label";
    unit.textContent = isImplRow ? t("code.loopImplSuf") : t("code.loopScanSuf");
    loopRow.append(llab, mins, unit);

    cardEl.append(head, duty, skillRow, loopRow);
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
  setTest(el, ok ? "ok" : "error", ok ? t("code.dirExists") : t("code.dirMissing"));
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
  if (!dir) return toast(t("toast.codeFillDir"));
  if (!code.task.trim()) return toast(t("toast.codeFillTask"));
  const agents = code.agents.filter((a) => codingProgram(a.worker));
  if (!agents.length) return toast(t("toast.codeNeedAgent"));
  const dirOk = await invoke<boolean>("dir_exists", { path: dir }).catch(() => false);
  if (!dirOk) return toast(tf("toast.codeDirMissing", { dir }));

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
    "队友之间通过项目根目录的 TEAM_NOTES.md 互通：发现问题/给出反馈就追加写进 TEAM_NOTES.md（注明针对哪个文件、什么问题）；动手前先看一眼 TEAM_NOTES.md 有没有给你的反馈。" +
    "如果对某个改动或反馈有不同意见、出现争议，不要盲目地直接改、也不要和队友来回互相覆盖：先在 TEAM_NOTES.md 里写清你的理由和你建议的方案，和相关队友协商，把讨论和最终结论都记在 TEAM_NOTES.md 里；达成共识、选出大家最认同的最优方案后，再按这个方案动手。";

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
        ? "先快速过一遍当前项目代码和 TEAM_NOTES.md，判断任务做到哪了：之前做过一部分就从没做完处接着做、绝不重复已完成的工作，全新才从头。确认进度后动手、直接改文件，每完成一步先简要记进 TEAM_NOTES.md（当进度清单，方便重启续上）。每一步按这个规则走：① 先看 TEAM_NOTES.md；② 有反馈→优先处理反馈；③ 没反馈→继续推进还没完成的任务；④ 如果当前 scope 已全部完成→不要制造任务、不要重复编辑共享文件、不要为了“有动作”而做动作，进入 Idle 状态，等待新的需求 / 缺陷 / 反馈 / 方向再继续。全程不要停下来问我、也不要等我确认。"
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

    // 持续协作: re-prompt this agent to re-scan the project + TEAM_NOTES.md, so the team keeps
    // reacting to each other's changes. The config is stored on the Term and the loop started via
    // startAgentLoop, so it can be stopped & re-started (per-agent or 全部) from the toolbar/tabs.
    if (code.loop) {
      const term = pane.active!;
      // Short nudge — the agent already knows its role/the TEAM_NOTES.md convention from launch.
      const nudge = isImpl
        ? `先看 TEAM_NOTES.md：有反馈优先处理；没反馈就继续推进还没完成的任务。若当前 scope 已全部完成，就别制造任务、别重复编辑共享文件、别为“有动作”而动作——进入 Idle 等待，有新需求/缺陷/反馈/方向再继续。`
        : `再巡检一遍：代码和 TEAM_NOTES.md 有没有新变化，有问题就处理并写进 TEAM_NOTES.md，没有就回"暂无"。`;
      // 主写(实现位)：写完一步后先休息可自定义的几分钟(默认 2)等用户介入；这段时间没人工干预(没新
      // 输出、没敲键盘)才提示它继续。审查/测试：按各自间隔(a.loopMins，留空用全局)巡检，可错开时序。
      const ownMins = a.loopMins ?? code.loopMins ?? 2.5;
      const REST_IMPL = Math.max(0.5, a.loopMins ?? 2) * 60000;
      term.loopParams = {
        nudge,
        minGapMs: isImpl ? REST_IMPL : Math.max(0.5, ownMins) * 60000 + i * 5000,
        quiet: isImpl ? REST_IMPL : 8000,
        userQuiet: isImpl ? REST_IMPL : 12000,
      };
      startAgentLoop(term);
    }
  });

  if (code.loop) {
    refreshTermToolbar();
    toast(tf("toast.loopStarted", { mins: code.loopMins || 2.5 }), "info");
  }
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

// ⌘V with an image on the clipboard (no text): claude reads the clipboard natively, so we leave
// it alone; for CLIs that don't (codex / gemini / grok …) we save the image to a temp PNG and type
// its path into the terminal (gemini references files with @, so prefix it there).
async function pasteClipboardImage(program: string, sid: string) {
  if (program === "claude") return; // claude handles image paste itself
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = it.types.find((t) => t.startsWith("image/"));
      if (!type) continue;
      const blob = await it.getType(type);
      const buf = new Uint8Array(await blob.arrayBuffer());
      const path = await invoke<string>("save_clip_image", { bytes: Array.from(buf) });
      if (!path) return;
      const ref = program === "gemini" ? `@${path} ` : `${path} `;
      await invoke("write_pty", { id: sid, data: ref }).catch(() => {});
      toast(tf("toast.pastedImagePath", { name: path.split("/").pop() ?? "" }), "info");
      return;
    }
  } catch {
    /* no image / no clipboard permission */
  }
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
  loopParams?: LoopParams; // 持续协作 config if launched as an agent — lets it be stopped & re-started
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
        <div class="launch-row"><label>${escHtml(t("term.cwd"))}</label><input class="cwd" value="~" /><button class="pick-cwd" type="button">${escHtml(t("term.pick"))}</button></div>
        <div class="launch-row"><label>${escHtml(t("term.args"))}</label><input class="args" placeholder="${escHtml(t("term.argsPh"))}" /></div>
        <div class="launch-btns">
          <button data-prog="">▶ ${escHtml(t("mode.term"))}</button>
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
      term.writeln(`\r\n\x1b[90m[${t("term.processExited")}]\x1b[0m`);
      if (this.sessionId === sid) {
        this.sessionId = null;
        this.pane.renderTabs();
        refreshTermToolbar();
      }
    });
    try {
      await invoke("spawn_pty", { id: sid, program, args, cwd, cols: term.cols, rows: term.rows, onData });
    } catch (err) {
      if (this.sessionId === sid) {
        this.sessionId = null;
        this.pane.renderTabs();
        refreshTermToolbar();
      }
      term.writeln(`\x1b[31m${tf("term.launchFailed", { msg: err instanceof Error ? err.message : String(err) })}\x1b[0m`);
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
        const sid0 = sid;
        const prog = this.program;
        navigator.clipboard
          .readText()
          .then((t) => {
            if (t) term.paste(t);
            else pasteClipboardImage(prog, sid0); // no text → maybe an image
          })
          .catch(() => pasteClipboardImage(prog, sid0));
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
    // Stop its 持续协作 loop now (don't wait for the timer's self-clean) so no orphaned timer
    // keeps firing and the toolbar state stays correct.
    codeLoops.filter((l) => l.term === t).forEach((l) => clearInterval(l.timer));
    codeLoops = codeLoops.filter((l) => l.term !== t);
    t.teardown();
    t.host.remove();
    refreshTermToolbar();
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
      const label = tm.launched ? tm.title : t("term.newTerminal");
      const chip = document.createElement("div");
      chip.className = "tab" + (tm === this.active ? " active" : "");
      chip.innerHTML = `<span class="tab-title">${escHtml(label)}</span>`;
      // 协作编程 agent (alive): a per-AI 停止/开启 toggle (停 = stop loop + Esc; 开 = restart loop).
      if (tm.loopParams && tm.sessionId) {
        const looping = termHasLoop(tm);
        const tog = document.createElement("button");
        tog.className = "tab-stop" + (looping ? " on" : "");
        tog.textContent = looping ? "■" : "▶";
        tog.title = looping ? t("term.stopAiTitle") : t("term.startAiTitle");
        tog.addEventListener("click", (e) => {
          e.stopPropagation();
          looping ? stopAgentWork(tm) : startAgentLoop(tm);
        });
        chip.appendChild(tog);
      }
      const close = document.createElement("button");
      close.className = "tab-close";
      close.title = t("tsk.close");
      close.textContent = "✕";
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeTab(tm);
      });
      chip.appendChild(close);
      chip.addEventListener("click", () => this.setActiveTerm(tm));
      this.tabsEl.appendChild(chip);
    }
    const add = document.createElement("button");
    add.className = "tab-add";
    add.textContent = "+";
    add.title = t("term.newTab");
    add.addEventListener("click", (e) => {
      e.stopPropagation();
      this.addTab(this.active?.cwd); // new tab inherits the active tab's cwd
    });
    this.tabsEl.appendChild(add);
    // ⚡ send a skill into the active terminal's running CLI — anytime, mid-conversation.
    const sk = document.createElement("button");
    sk.className = "tab-add";
    sk.textContent = t("term.skillBtn");
    sk.title = t("term.skillBtnTitle");
    sk.addEventListener("click", (e) => {
      e.stopPropagation();
      openTermSkillPicker(this.active);
    });
    this.tabsEl.appendChild(sk);
    // Prominent 停止/开启 for THIS pane's active AI, in the open space next to ⚡技能.
    const act = this.active;
    if (act && act.loopParams && act.sessionId) {
      const looping = termHasLoop(act);
      const ctl = document.createElement("button");
      ctl.className = "tab-agent-ctl" + (looping ? " on" : "");
      ctl.textContent = looping ? t("term.stopThisAi") : t("term.startThisAi");
      ctl.title = looping ? t("term.stopThisAiTitle") : t("term.startAiTitle");
      ctl.addEventListener("click", (e) => {
        e.stopPropagation();
        looping ? stopAgentWork(act) : startAgentLoop(act);
      });
      this.tabsEl.appendChild(ctl);
    }
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
function openTermSkillPicker(term: Term | null) {
  if (!term || !term.sessionId) return toast(t("toast.termNoCli"));
  termSkillTarget = term;
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
    e.textContent = skills.length ? t("skl.noMatch") : t("term.skillsEmpty");
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
    desc.textContent = s.description || t("skill.noDesc");
    row.append(nm, desc);
    row.addEventListener("click", async () => {
      const term = termSkillTarget;
      if (!term || !term.sessionId) {
        termSkillModal.classList.add("hidden");
        return toast(t("toast.termClosed"));
      }
      try {
        const body = skillBody(await invoke<string>("read_skill", { name: s.name }));
        const oneLine = body.replace(/\s*\n+\s*/g, " ").trim();
        if (oneLine) await invoke("write_pty", { id: term.sessionId, data: oneLine + "\r" });
        termSkillModal.classList.add("hidden");
        toast(tf("toast.skillSent", { name: s.name }), "info");
      } catch (e) {
        toast(tf("toast.sendFailed", { msg: e instanceof Error ? e.message : String(e) }));
      }
    });
    listEl.appendChild(row);
  }
}

let lastAppliedMode = "";
function applyMode() {
  const m = mode;
  // Results are mode-specific — clear the shared results panel when the mode actually changes so a
  // previous mode's output (e.g. generated images) doesn't linger into another screen. Guarded on
  // a real mode change so re-renders (e.g. language switch) don't wipe in-view results.
  if (m !== lastAppliedMode) {
    resultsEl.innerHTML = "";
    lastAppliedMode = m;
  }
  const isTerm = m === "term";
  geoEditor.classList.toggle("hidden", m !== "geo");
  pipeEditor.classList.toggle("hidden", m !== "pipe");
  rtEditor.classList.toggle("hidden", m !== "rt");
  codeEditor.classList.toggle("hidden", m !== "code");
  imgEditor.classList.toggle("hidden", m !== "img");
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
  $("#mode-img").classList.toggle("active", m === "img");
  // 终端 has no run/stop (terminals are live + independent); hide those buttons there.
  runBtn.classList.toggle("hidden", isTerm);
  stopBtn.classList.toggle("hidden", isTerm || !running);
  document.getElementById("geo-empty-hint")?.remove();
  renderSkills(); // click behavior + highlight differ per mode
  if (m === "code") renderCode();
  else if (m === "geo") renderGeo();
  else if (m === "rt") renderRt();
  else if (m === "img") renderDraw();
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
    el.textContent = t(hint);
    resultsEl.appendChild(el);
  }
}
// Values are i18n keys, resolved via t() in applyMode so they follow the current language.
const EMPTY_HINTS: Record<string, string> = {
  code: "empty.code",
  geo: "empty.geo",
  rt: "empty.rt",
  img: "empty.img",
};

// ---- wire up ----
$("#toggle-skills").addEventListener("click", () => {
  const hidden = skillsPanel.classList.toggle("hidden");
  $("#side-splitter").classList.toggle("hidden", hidden); // splitter follows the sidebar
});
$("#add-step").addEventListener("click", () => {
  steps.push({ title: t("step.newStep"), worker: "", role: "", prompt: "{{prev}}" });
  saveSteps();
  renderSteps();
});
runBtn.addEventListener("click", () =>
  mode === "geo"
    ? runGeo()
    : mode === "rt"
      ? runRoundtable()
      : mode === "code"
        ? runCoding()
        : mode === "img"
          ? runDraw()
          : run(),
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
$("#mode-img").addEventListener("click", () => {
  mode = "img";
  localStorage.setItem(LS_MODE, mode);
  applyMode();
});

// 图像 form fields
$<HTMLTextAreaElement>("#img-prompt").addEventListener("input", (e) => {
  draw.prompt = (e.target as HTMLTextAreaElement).value;
  saveDraw();
});
$("#img-clear").addEventListener("click", () => {
  draw.prompt = "";
  $<HTMLTextAreaElement>("#img-prompt").value = "";
  saveDraw();
});
$<HTMLSelectElement>("#img-source").addEventListener("change", (e) => {
  draw.worker = (e.target as HTMLSelectElement).value;
  saveDraw();
});
$<HTMLSelectElement>("#img-skill").addEventListener("change", (e) => {
  draw.skill = (e.target as HTMLSelectElement).value;
  saveDraw();
});
$("#img-ref-pick").addEventListener("click", () => $<HTMLInputElement>("#img-ref-input").click());
$<HTMLInputElement>("#img-ref-input").addEventListener("change", (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    drawRef = String(reader.result || "");
    renderDraw();
  };
  reader.readAsDataURL(f);
});
$("#img-ref-clear").addEventListener("click", () => {
  drawRef = "";
  $<HTMLInputElement>("#img-ref-input").value = "";
  renderDraw();
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
  $("#rt-rounds-label").textContent = tf("rt.roundsLabel", { n: rt.rounds });
  saveRt();
});
$<HTMLSelectElement>("#rt-moderator").addEventListener("change", (e) => {
  rt.moderator = (e.target as HTMLSelectElement).value;
  saveRt();
});
$("#rt-add").addEventListener("click", () => {
  const opts = chatWorkerOptions();
  if (!opts.length) return toast(t("toast.noModels"));
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
  toast(tf("toast.rtAdded", { n: rt.participants.length }), "info");
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
$("#stop-all-agents").addEventListener("click", () => {
  stopAllAgentsWork();
  toast(t("toast.allStopped"), "info");
});
$("#start-all-agents").addEventListener("click", () => {
  startAllAgentsWork();
  toast(t("toast.allStarted"), "info");
});
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
    toast(t("toast.loopStopped"), "info");
  }
});
$<HTMLInputElement>("#code-loop-mins").addEventListener("change", (e) => {
  const v = parseFloat((e.target as HTMLInputElement).value);
  code.loopMins = isNaN(v) ? 2.5 : Math.min(60, Math.max(0.5, v));
  (e.target as HTMLInputElement).value = String(code.loopMins);
  // Setting an interval means you want it scanning — flip the master switch on so the number
  // isn't silently inert (the #1 footgun: interval set but 持续协作 left unchecked).
  if (!code.loop) {
    code.loop = true;
    $<HTMLInputElement>("#code-loop").checked = true;
    toast(t("toast.loopAutoOn"), "info");
  }
  saveCode();
});
$("#code-add").addEventListener("click", () => {
  const opts = codingAgentOptions();
  if (!opts.length) return toast(t("toast.noCodingCli"));
  const used = code.agents.map((a) => a.worker);
  const unused = opts.find((o) => !used.includes(o.value));
  code.agents.push({ worker: (unused ?? opts[0]).value, duty: DUTY_SUGGEST[code.agents.length] ?? "", skills: [] });
  saveCode();
  renderCodeAgents();
  const last = $<HTMLDivElement>("#code-agents").lastElementChild as HTMLElement | null;
  last?.classList.add("just-added");
  last?.scrollIntoView({ block: "nearest" });
  setTimeout(() => last?.classList.remove("just-added"), 1100);
  toast(tf("toast.agentAdded", { n: code.agents.length }), "info");
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
    toast(tf("toast.openFolderFailed", { msg: e instanceof Error ? e.message : String(e) }));
  }
});
$("#code-new").addEventListener("click", async () => {
  try {
    const p = await invoke<string | null>("new_folder");
    if (p) {
      setCodeDir(p);
      toast(tf("toast.folderCreated", { path: p }), "info");
    }
  } catch (e) {
    toast(tf("toast.newFolderFailed", { msg: e instanceof Error ? e.message : String(e) }));
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
  $("#geo-len-label").textContent = tf("geo.lenLabel", { n: geo.length });
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
    toast(t("toast.copiedEntry"), "info");
  } catch {
    /* clipboard blocked */
  }
});

// ---- 协作编程·历史任务 modal: click a snapshot to reload it into the form ----
const codeHistModal = $<HTMLDivElement>("#code-hist-modal");
// Reload a saved task config into the 协作编程 form (deep-copy agents so edits don't mutate
// history) and jump to 协作编程 mode — used by both the 📋 modal and the top 历史 list.
function loadCodeTask(t: CodeTask) {
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
  mode = "code";
  localStorage.setItem(LS_MODE, mode);
  applyMode();
  renderCode();
  toast(tf("toast.filledBack", { title: t.title }), "info");
}
function renderCodeHist() {
  const listEl = $<HTMLDivElement>("#code-hist-list");
  listEl.innerHTML = "";
  if (!codeHist.length) {
    const empty = document.createElement("div");
    empty.className = "sidebar-note";
    empty.textContent = t("ch.empty");
    listEl.appendChild(empty);
    return;
  }
  for (const task of codeHist) {
    const item = document.createElement("div");
    item.className = "codehist-item";
    const d = new Date(task.at);
    const when = `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const main = document.createElement("div");
    main.className = "ch-main";
    const title = document.createElement("div");
    title.className = "ch-title";
    title.textContent = task.title;
    const meta = document.createElement("div");
    meta.className = "ch-meta";
    const who = task.agents.map((a) => a.worker).join(" · ") || t("ch.noAgent");
    meta.textContent = `${when} · ${shortCwd(task.dir) || task.dir || t("ch.noDir")} · ${who}`;
    main.append(title, meta);
    const del = document.createElement("button");
    del.className = "danger mini ch-del";
    del.textContent = "✕";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      codeHist = codeHist.filter((x) => x.id !== task.id);
      saveCodeHist();
      renderCodeHist();
    });
    item.append(main, del);
    item.addEventListener("click", () => {
      loadCodeTask(task);
      codeHistModal.classList.add("hidden");
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
twoStepDelete($<HTMLButtonElement>("#wf-del"), t("wf.del"), t("wf.delConfirm"), () => void deleteWorkflow());
$("#wf-new").addEventListener("click", () => {
  steps = [{ title: t("step.step1"), worker: "", role: "", prompt: "{{input}}" }];
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
  providers.push({ name: t("settings.newProvider"), endpoint: "", key: "", models: "" });
  renderProviders();
});
$("#add-cli").addEventListener("click", () => {
  clis.push({ name: t("settings.newCli"), program: "", args: "" });
  renderClis();
});
$("#add-video").addEventListener("click", () => {
  videos.push({ name: t("settings.newVideo"), endpoint: "", key: "", models: "", resolution: "1080p", ratio: "16:9", duration: "5" });
  renderVideos();
});
$("#add-image").addEventListener("click", () => {
  images.push({ name: t("settings.newImage"), endpoint: "", key: "", models: "", size: "1024x1024" });
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
resetSkillDel = twoStepDelete($<HTMLButtonElement>("#skill-delete"), t("wf.del"), t("skill.delConfirm"), () => {
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

// ---- i18n: fill the language picker, apply the current language, re-apply on change ----
// Apply the current language everywhere: static data-i18n elements AND all JS-built dynamic
// content (step cards, selects, style chips, lists, the active editor) — the latter is the part
// that only updates when re-rendered, so switching language must re-run those renders.
function applyLang() {
  applyI18n();
  $("#geo-len-label").textContent = tf("geo.lenLabel", { n: geo.length });
  $("#rt-rounds-label").textContent = tf("rt.roundsLabel", { n: rt.rounds });
  renderSteps();
  void refreshWorkflowList();
  void refreshSkills();
  applyMode(); // re-renders the active editor (geo styles, rt participants, code agents…)
}
const langSel = $<HTMLSelectElement>("#lang-select");
for (const l of LANGS) {
  const o = document.createElement("option");
  o.value = l.code;
  o.textContent = l.label;
  langSel.appendChild(o);
}
langSel.value = getLang();
langSel.addEventListener("change", () => {
  setLang(langSel.value as Lang);
  applyLang();
});
applyLang();
