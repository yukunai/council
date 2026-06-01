// Pure, side-effect free helpers extracted for testability (补测试 responsibility).
// These can be unit tested with Vitest without DOM or Tauri invoke.

export function parseModels(s: string): string[] {
  return s
    .split(/[\n,]/)
    .map((m) => m.trim())
    .filter(Boolean);
}

export function parseArgs(s: string): string[] {
  return s.trim() ? s.trim().split(/\s+/) : [];
}

// Template filling for pipeline steps.
export function fillTemplate(tpl: string, input: string, outputs: string[], idx: number): string {
  return tpl
    .replace(/\{\{\s*input\s*\}\}/g, input)
    .replace(/\{\{\s*prev\s*\}\}/g, idx > 0 ? outputs[idx - 1] ?? "" : input)
    .replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n: string) => outputs[parseInt(n, 10) - 1] ?? "");
}

// Upstream step indices (0-based) that a pipeline step depends on, derived from its template:
// {{prev}} → the immediately preceding step (idx-1); {{N}} → step N (1-based). {{input}} adds no
// dependency. Only backward refs (< idx) count, since outputs only holds earlier steps. The
// pipeline runner uses this to run independent steps concurrently (dependency-aware waves)
// instead of strictly serially; a pure linear chain (every step uses {{prev}}) yields a full
// chain of deps and therefore stays serial.
export function stepDeps(tpl: string, idx: number): number[] {
  const deps = new Set<number>();
  if (idx > 0 && /\{\{\s*prev\s*\}\}/.test(tpl)) deps.add(idx - 1);
  for (const m of tpl.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
    const j = parseInt(m[1], 10) - 1; // {{N}} is 1-based
    if (j >= 0 && j < idx) deps.add(j);
  }
  return [...deps].sort((a, b) => a - b);
}

// Strip YAML frontmatter from a SKILL.md (or any MD with --- ... --- header), leaving the instruction body.
// Also strips a leading BOM if present.
export function skillBody(content: string): string {
  const t = content.replace(/^\uFEFF/, "");
  if (t.startsWith("---")) {
    const end = t.indexOf("\n---", 3);
    if (end !== -1) {
      const after = t.indexOf("\n", end + 1);
      return after !== -1 ? t.slice(after + 1).trim() : "";
    }
  }
  return t.trim();
}

// Rough Chinese character count (ignore whitespace) for GEO 字数 readout.
export function cnLen(s: string): number {
  return s.replace(/\s+/g, "").length;
}

// Split GEO output on the ===小推文=== delimiter (tolerates variations in spacing).
export function splitGeo(text: string): { article: string; tweet: string } {
  const parts = text.split(/\n[ \t]*={2,}\s*小推文\s*={2,}[ \t]*\n?/);
  if (parts.length >= 2) return { article: parts[0].trim(), tweet: parts.slice(1).join("\n").trim() };
  return { article: text.trim(), tweet: "" };
}

export function extractSvg(text: string): string {
  const m = text.match(/<svg[\s\S]*?<\/svg>/i);
  return m ? m[0] : "";
}

// CLI output is the user's own local agent, but strip scripts/handlers from SVG before
// injecting it into the webview just to be safe.
export function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "");
}

// Worker decoding helper (used by UI labels and run logic).
export function decodeWorker(
  v: string,
):
  | { kind: "cli"; name: string }
  | { kind: "video"; provider: string; model: string }
  | { kind: "http"; provider: string; model: string }
  | { kind: "image"; provider: string; model: string } {
  if (v.startsWith("cli::")) return { kind: "cli", name: v.slice(5) };
  if (v.startsWith("vid::")) {
    const parts = v.split("::");
    return { kind: "video", provider: parts[1] ?? "", model: parts.slice(2).join("::") };
  }
  if (v.startsWith("img::")) {
    const parts = v.split("::");
    return { kind: "image", provider: parts[1] ?? "", model: parts.slice(2).join("::") };
  }
  const parts = v.split("::");
  return { kind: "http", provider: parts[1] ?? "", model: parts.slice(2).join("::") };
}
