import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

const CONTENT_LABEL = "council-browser-content";
const DEFAULT_URL = "https://www.baidu.com";

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

let currentUrl = normalizeUrl(new URLSearchParams(location.search).get("url") || DEFAULT_URL);
let contentView: Webview | null = null;
let sizing = false;

function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return DEFAULT_URL;
  if (/^(https?:\/\/)/i.test(s)) return s;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/.*)?$/i.test(s)) return `http://${s}`;
  if (/^[\w.-]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(s)) return `https://${s}`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

function setStatus(text: string, kind: "info" | "error" = "info") {
  const el = $<HTMLDivElement>("#browser-status");
  el.textContent = text;
  el.classList.toggle("error", kind === "error");
}

function setUrl(url: string) {
  currentUrl = normalizeUrl(url);
  $<HTMLInputElement>("#browser-url").value = currentUrl;
}

async function fitContentView() {
  if (!contentView || sizing) return;
  sizing = true;
  try {
    const r = $<HTMLDivElement>("#browser-view-host").getBoundingClientRect();
    await contentView.setPosition(new LogicalPosition(Math.round(r.left), Math.round(r.top)));
    await contentView.setSize(new LogicalSize(Math.max(320, Math.round(r.width)), Math.max(240, Math.round(r.height))));
  } finally {
    sizing = false;
  }
}

async function createContentView() {
  const r = $<HTMLDivElement>("#browser-view-host").getBoundingClientRect();
  contentView = new Webview(getCurrentWindow(), CONTENT_LABEL, {
    url: currentUrl,
    x: Math.round(r.left),
    y: Math.round(r.top),
    width: Math.max(320, Math.round(r.width)),
    height: Math.max(240, Math.round(r.height)),
    focus: true,
  });
  contentView.once("tauri://created", () => {
    setStatus("已打开");
    void fitContentView();
  });
  contentView.once("tauri://error", (e) => {
    setStatus(`打开失败：${String(e.payload)}`, "error");
  });
}

async function navigate(raw: string) {
  const url = normalizeUrl(raw);
  setUrl(url);
  setStatus("正在打开...");
  try {
    if (!contentView) {
      await createContentView();
      return;
    }
    currentUrl = await invoke<string>("browser_navigate", { label: CONTENT_LABEL, url });
    $<HTMLInputElement>("#browser-url").value = currentUrl;
    setStatus("已打开");
  } catch (e) {
    setStatus(`打开失败：${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

async function syncActualUrl() {
  if (!contentView) return;
  try {
    const url = await invoke<string>("browser_url", { label: CONTENT_LABEL });
    if (url && url !== currentUrl) {
      currentUrl = url;
      $<HTMLInputElement>("#browser-url").value = currentUrl;
    }
  } catch {
    /* view may be closing */
  }
}

async function runBrowserAction(action: "back" | "forward" | "reload") {
  if (!contentView) return;
  try {
    if (action === "reload") await invoke("browser_reload", { label: CONTENT_LABEL });
    else await invoke("browser_history", { label: CONTENT_LABEL, direction: action });
    window.setTimeout(() => void syncActualUrl(), 400);
  } catch (e) {
    setStatus(`操作失败：${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

$("#browser-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void navigate($<HTMLInputElement>("#browser-url").value);
});
$("#browser-back").addEventListener("click", () => void runBrowserAction("back"));
$("#browser-forward").addEventListener("click", () => void runBrowserAction("forward"));
$("#browser-reload").addEventListener("click", () => void runBrowserAction("reload"));
$("#browser-copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(currentUrl);
  setStatus("链接已复制");
});
$("#browser-insert").addEventListener("click", async () => {
  await emitTo("main", "browser-insert-url", currentUrl);
  setStatus("已插入聊天输入框");
});
$("#browser-external").addEventListener("click", async () => {
  await invoke("browser_open_external", { url: currentUrl });
});

window.addEventListener("resize", () => void fitContentView());
new ResizeObserver(() => void fitContentView()).observe($<HTMLDivElement>("#browser-view-host"));
window.addEventListener("beforeunload", () => {
  void contentView?.close();
});

void listen<string>("browser-open-url", (e) => void navigate(e.payload));
setUrl(currentUrl);
void createContentView();
window.setInterval(() => void syncActualUrl(), 1200);
