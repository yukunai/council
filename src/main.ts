import { invoke, Channel } from "@tauri-apps/api/core";

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
  { name: "Codex (GPT)", program: "codex", args: "exec" },
  { name: "Gemini CLI", program: "gemini", args: "-p" },
  { name: "Grok CLI", program: "grok", args: "", note: "参数按你装的 grok CLI 调整" },
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
// Merge over defaults so a geo object persisted by an older build (missing newer
// fields like source/material/image) doesn't blow up on access.
let geo: GeoState = { ...DEFAULT_GEO, ...load(LS_GEO, {}) };
let images: ImageProvider[] = load(LS_IMAGES, DEFAULT_IMAGES);
let mode: string = load(LS_MODE, "pipe");
function saveGeo() {
  localStorage.setItem(LS_GEO, JSON.stringify(geo));
}
function saveImages() {
  localStorage.setItem(LS_IMAGES, JSON.stringify(images));
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

function parseModels(s: string): string[] {
  return s
    .split(/[\n,]/)
    .map((m) => m.trim())
    .filter(Boolean);
}
function parseArgs(s: string): string[] {
  return s.trim() ? s.trim().split(/\s+/) : [];
}

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

function decodeWorker(
  v: string,
):
  | { kind: "cli"; name: string }
  | { kind: "video"; provider: string; model: string }
  | { kind: "http"; provider: string; model: string } {
  if (v.startsWith("cli::")) return { kind: "cli", name: v.slice(5) };
  if (v.startsWith("vid::")) {
    const parts = v.split("::");
    return { kind: "video", provider: parts[1] ?? "", model: parts.slice(2).join("::") };
  }
  const parts = v.split("::");
  return { kind: "http", provider: parts[1] ?? "", model: parts.slice(2).join("::") };
}

// Make sure every step points at a worker that still exists.
function normalizeWorkers() {
  const opts = workerOptions();
  const valid = new Set(opts.map((o) => o.value));
  const fallback = opts[0]?.value ?? "";
  for (const s of steps) {
    if (!valid.has(s.worker)) s.worker = fallback;
  }
}

// Strip YAML frontmatter from a SKILL.md, leaving the instruction body.
function skillBody(content: string): string {
  const t = content.replace(/^﻿/, "");
  if (t.startsWith("---")) {
    const end = t.indexOf("\n---", 3);
    if (end !== -1) {
      const after = t.indexOf("\n", end + 1);
      return after !== -1 ? t.slice(after + 1).trim() : "";
    }
  }
  return t.trim();
}

// ---- step editor ----
function renderSteps() {
  normalizeWorkers();
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
    for (const o of opts) {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.value === step.worker) opt.selected = true;
      worker.appendChild(opt);
    }
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
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "（不挂技能）";
    skill.appendChild(none);
    for (const s of skills) {
      const o = document.createElement("option");
      o.value = s.name;
      o.textContent = s.name;
      if (s.name === step.skill) o.selected = true;
      skill.appendChild(o);
    }
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
}

// ---- template filling ----
function fillTemplate(tpl: string, input: string, outputs: string[], idx: number): string {
  return tpl
    .replace(/\{\{\s*input\s*\}\}/g, input)
    .replace(/\{\{\s*prev\s*\}\}/g, idx > 0 ? outputs[idx - 1] ?? "" : input)
    .replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n: string) => outputs[parseInt(n, 10) - 1] ?? "");
}

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
    try {
      await runWorker(
        step.worker,
        system,
        prompt,
        (text) => {
          acc += text;
          card.body.textContent = acc;
          scheduleScroll();
        },
        (url) => {
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
      outputs[i] = videoUrl || acc;
      card.setStatus("done", my !== genId ? "已停止" : "完成");
    } catch (e) {
      if (my !== genId) break;
      card.body.classList.add("error");
      card.body.textContent = e instanceof Error ? e.message : String(e);
      card.setStatus("error", "出错");
      break;
    }
  }

  endRun(my);
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
function renderMarket() {
  marketList.innerHTML = "";
  for (const preset of PRESETS) {
    const item = document.createElement("div");
    item.className = "market-item" + (preset.soon ? " soon" : "");

    const info = document.createElement("div");
    info.className = "market-info";
    const name = document.createElement("div");
    name.className = "market-name";
    name.textContent = preset.name;
    info.appendChild(name);
    if (preset.endpoint) {
      const ep = document.createElement("div");
      ep.className = "market-ep";
      ep.textContent = preset.endpoint;
      info.appendChild(ep);
    }
    if (preset.models) {
      const models = document.createElement("div");
      models.className = "market-models";
      models.textContent = "模型：" + parseModels(preset.models).join("、");
      info.appendChild(models);
    }
    if (preset.note) {
      const note = document.createElement("div");
      note.className = "market-note";
      note.textContent = preset.note;
      info.appendChild(note);
    }

    const add = document.createElement("button");
    add.className = "market-add";
    const already = providers.some((p) => p.name === preset.name);
    if (preset.soon) {
      add.textContent = "不可用";
      add.disabled = true;
    } else if (already) {
      add.textContent = "已添加";
      add.disabled = true;
    } else {
      add.textContent = "＋ 添加";
      add.addEventListener("click", () => {
        providers.push({
          name: preset.name,
          endpoint: preset.endpoint,
          key: "",
          models: preset.models,
        });
        saveProviders();
        renderSteps();
        renderMarket();
      });
    }

    item.append(info, add);
    marketList.appendChild(item);
  }

  // local CLI presets
  marketCliList.innerHTML = "";
  for (const preset of CLI_PRESETS) {
    const item = document.createElement("div");
    item.className = "market-item";
    const info = document.createElement("div");
    info.className = "market-info";
    const name = document.createElement("div");
    name.className = "market-name";
    name.textContent = preset.name;
    info.appendChild(name);
    const cmd = document.createElement("div");
    cmd.className = "market-ep";
    cmd.textContent = `${preset.program} ${preset.args} <指令>`.trim();
    info.appendChild(cmd);
    if (preset.note) {
      const note = document.createElement("div");
      note.className = "market-note";
      note.textContent = preset.note;
      info.appendChild(note);
    }

    const add = document.createElement("button");
    add.className = "market-add";
    const already = clis.some((c) => c.name === preset.name);
    if (already) {
      add.textContent = "已添加";
      add.disabled = true;
    } else {
      add.textContent = "＋ 添加";
      add.addEventListener("click", () => {
        clis.push({ name: preset.name, program: preset.program, args: preset.args });
        saveClis();
        renderSteps();
        renderMarket();
      });
    }
    item.append(info, add);
    marketCliList.appendChild(item);
  }

  // video presets
  marketVideoList.innerHTML = "";
  for (const preset of VIDEO_PRESETS) {
    const item = document.createElement("div");
    item.className = "market-item";
    const info = document.createElement("div");
    info.className = "market-info";
    const name = document.createElement("div");
    name.className = "market-name";
    name.textContent = preset.name;
    info.appendChild(name);
    const ep = document.createElement("div");
    ep.className = "market-ep";
    ep.textContent = preset.endpoint;
    info.appendChild(ep);
    const m = document.createElement("div");
    m.className = "market-models";
    m.textContent = `模型：${parseModels(preset.models).join("、")} · ${preset.resolution} ${preset.ratio} ${preset.duration}s`;
    info.appendChild(m);

    const add = document.createElement("button");
    add.className = "market-add";
    const already = videos.some((v) => v.name === preset.name);
    if (already) {
      add.textContent = "已添加";
      add.disabled = true;
    } else {
      add.textContent = "＋ 添加";
      add.addEventListener("click", () => {
        videos.push({ ...preset });
        saveVideos();
        renderSteps();
        renderMarket();
      });
    }
    item.append(info, add);
    marketVideoList.appendChild(item);
  }

  // image presets
  marketImageList.innerHTML = "";
  for (const preset of IMAGE_PRESETS) {
    const item = document.createElement("div");
    item.className = "market-item";
    const info = document.createElement("div");
    info.className = "market-info";
    const name = document.createElement("div");
    name.className = "market-name";
    name.textContent = preset.name;
    info.appendChild(name);
    const ep = document.createElement("div");
    ep.className = "market-ep";
    ep.textContent = preset.endpoint;
    info.appendChild(ep);
    const m = document.createElement("div");
    m.className = "market-models";
    m.textContent = `模型：${parseModels(preset.models).join("、")} · ${preset.size}`;
    info.appendChild(m);

    const add = document.createElement("button");
    add.className = "market-add";
    const already = images.some((v) => v.name === preset.name);
    if (already) {
      add.textContent = "已添加";
      add.disabled = true;
    } else {
      add.textContent = "＋ 添加";
      add.addEventListener("click", () => {
        images.push({ ...preset });
        saveImages();
        renderSteps();
        renderMarket();
      });
    }
    item.append(info, add);
    marketImageList.appendChild(item);
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
}

function renderSkills() {
  skillsListEl.innerHTML = "";
  if (skills.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-note";
    empty.textContent = "还没有技能。点「＋ 新建」或「⇄ 仓库」下载。";
    skillsListEl.appendChild(empty);
    return;
  }
  const geoMode = mode === "geo";
  // Mode-aware hint: in 单篇 a click selects the skill for this article; in 流水线 it edits.
  const note = document.createElement("div");
  note.className = "sidebar-note";
  note.textContent = geoMode
    ? "单篇模式：点技能 = 选用到本篇（再点取消）；✎ 编辑。"
    : "流水线模式：点技能 = 编辑；挂到步骤用步骤里的技能下拉。";
  skillsListEl.appendChild(note);

  for (const s of skills) {
    const item = document.createElement("div");
    const active = geoMode && s.name === geo.skill;
    item.className = "skill-item" + (active ? " active" : "");

    const head = document.createElement("div");
    head.className = "skill-item-head";
    const name = document.createElement("div");
    name.className = "skill-name";
    name.textContent = s.name;
    const edit = document.createElement("button");
    edit.className = "skill-edit mini";
    edit.textContent = "✎";
    edit.title = "编辑这条技能";
    edit.addEventListener("click", (e) => {
      e.stopPropagation();
      openSkillEditor(s.name);
    });
    const del = document.createElement("button");
    del.className = "skill-edit mini";
    del.textContent = "🗑";
    del.title = "删除这条技能（点两下确认）";
    twoStepDelete(del, "🗑", "确认?", () => void doDeleteSkill(s.name));
    head.append(name, edit, del);

    const desc = document.createElement("div");
    desc.className = "skill-desc";
    desc.textContent = s.description || "（无描述）";
    item.append(head, desc);

    if (active) {
      const badge = document.createElement("div");
      badge.className = "skill-badge";
      badge.textContent = "✓ 单篇已选用";
      item.appendChild(badge);
    }

    item.addEventListener("click", () => {
      if (mode === "geo") {
        // Toggle: click the active one again to clear back to built-in GEO rules.
        geo.skill = geo.skill === s.name ? "" : s.name;
        saveGeo();
        refreshGeoSelectors(); // sync the 单篇 技能 dropdown
        renderSkills(); // re-highlight
      } else {
        openSkillEditor(s.name);
      }
    });
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
  const bodyEl = $<HTMLTextAreaElement>("#skill-body");
  const delBtn = $<HTMLButtonElement>("#skill-delete");
  nameEl.value = name ?? "";
  descEl.value = "";
  bodyEl.value = "";
  delBtn.classList.toggle("hidden", !name);
  if (name) {
    try {
      const content = await invoke<string>("read_skill", { name });
      const m = content.match(/description:\s*(.*)/);
      descEl.value = m ? m[1].trim() : "";
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
  const body = $<HTMLTextAreaElement>("#skill-body").value;
  if (!name) return toast("技能要有名字");
  try {
    await invoke("save_skill", { name, description, body });
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
      let name = nameM ? nameM[1].trim() : "";
      if (!name) {
        // Fall back to the containing folder name (folder pick) or the file stem.
        const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || "";
        const parts = rel.split("/").filter(Boolean);
        name = parts.length >= 2 ? parts[parts.length - 2] : f.name.replace(/\.(md|markdown)$/i, "");
      }
      await invoke("save_skill", { name, description: descM ? descM[1].trim() : "", body: skillBody(text) });
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
  wfLoadEl.innerHTML = "<option value=\"\">载入已存…</option>";
  for (const n of names) {
    const opt = document.createElement("option");
    opt.value = n;
    opt.textContent = n;
    wfLoadEl.appendChild(opt);
  }
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
  if (!name) return;
  if (!confirm(`删除工作流「${name}」？`)) return;
  try {
    await invoke("delete_workflow", { name });
    await refreshWorkflowList();
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
  const opts = workerOptions().filter((o) => !o.value.startsWith("vid::"));
  if (geo.worker && !opts.some((o) => o.value === geo.worker)) geo.worker = "";
  if (!geo.worker) geo.worker = opts[0]?.value ?? "";
  ws.innerHTML = "";
  for (const o of opts) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.value === geo.worker) opt.selected = true;
    ws.appendChild(opt);
  }

  const sk = $<HTMLSelectElement>("#geo-skill");
  sk.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "（用内置 GEO 规范）";
  sk.appendChild(none);
  if (geo.skill && !skills.some((s) => s.name === geo.skill)) geo.skill = "";
  for (const s of skills) {
    const o = document.createElement("option");
    o.value = s.name;
    o.textContent = s.name;
    if (s.name === geo.skill) o.selected = true;
    sk.appendChild(o);
  }

  // 配图来源: local CLIs (→ SVG) + HTTP image providers (→ real image)
  const im = $<HTMLSelectElement>("#geo-image");
  const imgOpts: { value: string; label: string }[] = [];
  for (const c of clis) imgOpts.push({ value: `cli::${c.name}`, label: `SVG · ${c.name}` });
  for (const p of images) {
    for (const m of parseModels(p.models)) {
      imgOpts.push({ value: `img::${p.name}::${m}`, label: `🖼 ${p.name} · ${m}` });
    }
  }
  if (geo.image && !imgOpts.some((o) => o.value === geo.image)) geo.image = "";
  im.innerHTML = "";
  const imgNone = document.createElement("option");
  imgNone.value = "";
  imgNone.textContent = "（不配图）";
  im.appendChild(imgNone);
  for (const o of imgOpts) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.value === geo.image) opt.selected = true;
    im.appendChild(opt);
  }
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

// Rough Chinese character count (ignore whitespace) for the 字数 readout.
function cnLen(s: string): number {
  return s.replace(/\s+/g, "").length;
}

// Split the model output into article + tweet on the ===小推文=== delimiter line.
function splitGeo(text: string): { article: string; tweet: string } {
  const parts = text.split(/\n[ \t]*={2,}\s*小推文\s*={2,}[ \t]*\n?/);
  if (parts.length >= 2) return { article: parts[0].trim(), tweet: parts.slice(1).join("\n").trim() };
  return { article: text.trim(), tweet: "" };
}

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

  return {
    streamText: (s: string) => {
      body.textContent = s;
    },
    // Replace streamed text with an editable textarea once generation finishes.
    setEditable: (s: string) => {
      body.innerHTML = "";
      const ta = document.createElement("textarea");
      ta.className = "result-edit";
      ta.value = s;
      ta.rows = Math.min(34, Math.max(6, s.split("\n").length + 1));
      body.appendChild(ta);
      getText = () => ta.value;
    },
    setError: (s: string) => {
      body.classList.add("error");
      body.textContent = s;
    },
    setStatus,
    // Current text (edited value once setEditable ran, else streamed text).
    getText: () => getText(),
  };
}

function extractSvg(text: string): string {
  const m = text.match(/<svg[\s\S]*?<\/svg>/i);
  return m ? m[0] : "";
}
// CLI output is the user's own local agent, but strip scripts/handlers from SVG before
// injecting it into the webview just to be safe.
function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "");
}

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

// Top-of-results bar: copy the whole article and export it (with images + tweet) as Markdown.
function makeGeoToolbar(buildMarkdown: () => string, titleHint: string) {
  const copy = document.createElement("button");
  copy.className = "mini";
  copy.textContent = "复制全文";
  const exp = document.createElement("button");
  exp.className = "mini primary";
  exp.textContent = "导出 Markdown";
  const { setStatus } = cardShell("整篇", { extras: [copy, exp], prepend: true, body: false });

  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(buildMarkdown());
      copy.textContent = "已复制";
      setTimeout(() => (copy.textContent = "复制全文"), 1200);
    } catch {
      /* clipboard blocked */
    }
  });
  exp.addEventListener("click", () => {
    const safe = (titleHint || "article").replace(/[\/\\:*?"<>|]+/g, "").slice(0, 40).trim() || "article";
    const blob = new Blob([buildMarkdown()], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safe}.md`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus("done", "已导出");
    setTimeout(() => setStatus("done", ""), 1500);
  });
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
    makeGeoToolbar(buildMarkdown, geo.title.trim() || article.split("\n")[0].replace(/^#+\s*/, "").trim());

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

function applyMode() {
  const geoMode = mode === "geo";
  geoEditor.classList.toggle("hidden", !geoMode);
  pipeEditor.classList.toggle("hidden", geoMode);
  $("#add-step").classList.toggle("hidden", geoMode);
  wfbar.classList.toggle("hidden", geoMode);
  $("#mode-pipe").classList.toggle("active", !geoMode);
  $("#mode-geo").classList.toggle("active", geoMode);
  document.getElementById("geo-empty-hint")?.remove();
  renderSkills(); // click behavior + highlight differ per mode
  if (geoMode) {
    renderGeo();
    if (!resultsEl.children.length) {
      const hint = document.createElement("div");
      hint.id = "geo-empty-hint";
      hint.className = "empty";
      hint.textContent = "填好左侧表单（标题 / 原文 / 链接 / 路线 任一即可），点「运行」生成结构文 + 小推文。";
      resultsEl.appendChild(hint);
    }
  }
}

// ---- wire up ----
$("#toggle-skills").addEventListener("click", () => skillsPanel.classList.toggle("hidden"));
$("#add-step").addEventListener("click", () => {
  steps.push({ title: "新步骤", worker: "", role: "", prompt: "{{prev}}" });
  saveSteps();
  renderSteps();
});
runBtn.addEventListener("click", () => (mode === "geo" ? runGeo() : run()));
stopBtn.addEventListener("click", () => {
  genId++; // invalidate the in-flight run so any pending await no-ops
  if (cancelCurrent) cancelCurrent();
  // Always unstick the UI, even if we're blocked on a pre-stream await (fetch/skill read).
  running = false;
  cancelCurrent = null;
  stopBtn.classList.add("hidden");
  runBtn.classList.remove("hidden");
});

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

$("#wf-save").addEventListener("click", saveWorkflow);
$("#wf-del").addEventListener("click", deleteWorkflow);
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
