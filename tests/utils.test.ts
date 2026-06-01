import { describe, it, expect } from "vitest";
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
} from "../src/utils";

describe("parseModels", () => {
  it("splits on newlines and commas", () => {
    expect(parseModels("a\nb, c")).toEqual(["a", "b", "c"]);
    expect(parseModels("")).toEqual([]);
  });
});

describe("parseArgs", () => {
  it("splits on whitespace", () => {
    expect(parseArgs("-p --foo")).toEqual(["-p", "--foo"]);
    expect(parseArgs("")).toEqual([]);
  });
});

describe("fillTemplate", () => {
  it("replaces input/prev/N placeholders (prev uses prior step output for idx>0)", () => {
    // idx=1 means second step (0-based): {{prev}} should resolve to outputs[0]
    const out = fillTemplate("{{input}} + {{prev}} + {{2}}", "X", ["A", "B"], 1);
    expect(out).toBe("X + A + B");
  });
  it("falls back gracefully for missing refs", () => {
    expect(fillTemplate("{{3}}", "in", ["o1"], 0)).toBe("");
  });
});

describe("stepDeps", () => {
  it("no upstream dep when only {{input}} / literal", () => {
    expect(stepDeps("分析 {{input}}", 2)).toEqual([]);
    expect(stepDeps("固定文本", 1)).toEqual([]);
  });
  it("{{prev}} depends on the immediately preceding step (idx-1)", () => {
    expect(stepDeps("{{prev}}", 3)).toEqual([2]);
    expect(stepDeps("{{prev}}", 0)).toEqual([]); // first step: prev is input, not a dep
  });
  it("{{N}} is 1-based; only backward refs count, de-duped + sorted", () => {
    expect(stepDeps("{{1}} 和 {{3}}", 4)).toEqual([0, 2]);
    expect(stepDeps("{{prev}} {{2}} {{2}}", 3)).toEqual([1, 2]); // prev=2, {{2}}=1
    expect(stepDeps("{{5}}", 2)).toEqual([]); // forward/self ref ignored
  });
});

describe("skillBody", () => {
  it("strips frontmatter and BOM", () => {
    const md = "\uFEFF---\nname: x\ndescription: y\n---\n\nDo the work";
    expect(skillBody(md)).toBe("Do the work");
  });
  it("returns original when no frontmatter", () => {
    expect(skillBody("plain body")).toBe("plain body");
  });
});

describe("cnLen", () => {
  it("counts CJK chars ignoring spaces", () => {
    expect(cnLen("你好 世界")).toBe(4);
    expect(cnLen("abc 123")).toBe(6);
  });
});

describe("splitGeo", () => {
  it("splits on the contract delimiter", () => {
    const t = "正文部分\n\n===小推文===\n推文内容";
    const { article, tweet } = splitGeo(t);
    expect(article).toContain("正文");
    expect(tweet).toContain("推文");
  });
  it("returns whole as article when no delimiter", () => {
    const { article, tweet } = splitGeo("只有正文");
    expect(article).toBe("只有正文");
    expect(tweet).toBe("");
  });
});

describe("extractSvg / sanitizeSvg", () => {
  it("extracts first svg", () => {
    const svg = extractSvg('foo <svg viewBox="0 0 10 10"><rect/></svg> bar');
    expect(svg).toContain("<svg");
  });
  it("sanitizes event handlers and scripts", () => {
    const dirty = '<svg onload="evil()"><script>alert(1)</script><rect onclick="x()"/></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain("onload");
    expect(clean).not.toContain("onclick");
    expect(clean).not.toContain("<script");
  });
});

describe("decodeWorker", () => {
  it("parses cli / vid / img / m:: kinds", () => {
    expect(decodeWorker("cli::Claude Code")).toEqual({ kind: "cli", name: "Claude Code" });
    expect(decodeWorker("vid::Seed::m1")).toEqual({ kind: "video", provider: "Seed", model: "m1" });
    expect(decodeWorker("img::Volc::seedream")).toEqual({ kind: "image", provider: "Volc", model: "seedream" });
    expect(decodeWorker("m::Deep::v4")).toEqual({ kind: "http", provider: "Deep", model: "v4" });
  });
});
