import { parseClock } from "./transcript.mjs";

export function noteBudget(duration = 0, { depth = "auto" } = {}) {
  if (!["auto", "shallow", "detailed", "legacy"].includes(depth)) throw new Error("depth 必须为 auto/shallow/detailed");
  const selected = depth === "auto" ? duration > 1800 ? "shallow" : "detailed" : depth;
  return { depth: selected, maxChars: selected === "shallow" ? 400 : duration > 1800 ? 2600 : duration > 600 ? 2000 : 900,
    targetChars: selected === "shallow" || selected === "legacy" && duration > 1800 ? 200 : duration > 600 ? 1600 : 700 };
}

export function sheetBudget(duration) { return duration <= 300 ? 4 : duration <= 1800 ? 8 : 12; }

export function noteBody(text) {
  return String(text).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
    .split(/(?:\r?\n---\s*)?\r?\n## 原始素材\s*\r?\n/)[0];
}

const ts = "(?:\\d{1,3}:)?\\d{1,3}:[0-5]\\d(?:\\.\\d{1,3})?";
function citationPattern() {
  return new RegExp("\\*\\*("+ts+")\\*\\*|[\\[【]("+ts+")[\\]】]|[（(]("+ts+")[）)]|("+ts+")\\s*[-–—~～〜]\\s*("+ts+")|(?:@|时间戳[：:]?|——)\\s*("+ts+")", "g");
}

const codePattern = /```[\s\S]*?```|`[^`\r\n]*`/g;

/** Explicit references only; bare ratios and scores stay ordinary content. */
export function citedTimestamps(text) {
  const body = noteBody(text).replace(codePattern, "");
  const values = [];
  for (const m of body.matchAll(citationPattern())) for (const v of m.slice(1)) if (v) values.push(parseClock(v));
  for (const m of body.matchAll(/https?:\/\/[^\s)]+[?&]t=(\d+(?:\.\d+)?)/g)) values.push(Number(m[1]));
  return values;
}

export function bodyMetrics(text) {
  const body = noteBody(text), rawChars = [...body.replace(/\s/g, "")].length;
  const code = [];
  const protectedBody = body.replace(codePattern, (value) => { code.push(value.replace(/^```[^\n]*\n|\n```$/g, "").replace(/`/g, "")); return `\uE000${code.length - 1}\uE001`; });
  const plain = protectedBody.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, (_, label) => citedTimestamps("["+label+"]").length ? "" : label)
    .replace(citationPattern(), "").replace(/https?:\/\/[^\s)]+/g, "")
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/[*_\x60]/g, "").replace(/\uE000(\d+)\uE001/g, (_, n) => code[Number(n)]).replace(/\s/g, "");
  return { rawChars, contentChars: [...plain].length, citations: citedTimestamps(body).length };
}

export const bodyChars = (text) => bodyMetrics(text).contentChars;

export function citationAudit(text, duration, { kind = "summary" } = {}) {
  const values = citedTimestamps(text), distinct = new Set(values).size, errors = [], warnings = [];
  if (!(duration > 0)) warnings.push("视频时长未知，未执行时间戳越界检查");
  else if (values.some((v) => v < 0 || v > duration + 1)) errors.push("显式时间戳超出本 P 时长（容差 1 秒）");
  if (kind === "summary" && distinct < 3) warnings.push(distinct === 0 ? "没有可识别的时间戳引用" : "只有 "+distinct+" 个不同时间锚，偏好要求至少 3 个");
  const bare = [];
  for (const line of noteBody(text).replace(codePattern, "").split(/\r?\n/)) {
    if (/比例|比分|配比|赔率/.test(line) || citedTimestamps(line).length) continue;
    const m = line.trim().match(new RegExp("^(?:[-*+]\\s+|\\d+[.)]\\s+)?("+ts+")(?=\\s|[：:—–-]|$)"));
    if (m) bare.push(parseClock(m[1]));
  }
  if (duration > 0 && bare.length >= 3 && bare.every((v) => v > duration + 1)) errors.push("至少三条要点开头的裸时间戳全部越界");
  return { values, distinct, bare, errors, warnings };
}
