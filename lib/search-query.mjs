/**
 * 自然语言查询 → 可验证的约束。
 *
 * B 站搜索没有语义理解，只有词命中。所以这里的工作是把口语里的
 * "那个讲四层工作边界的视频""最近一周 10 分钟左右 DSH 插件" 拆成
 * 能拿去打分和过滤的东西：硬 token、时长窗、时间窗、UP 名、口水词。
 */

const STOP = new Set([
  "那个", "这个", "这期", "那期", "一期", "视频", "影片", "讲的", "说的", "讲", "说", "关于",
  "怎么", "如何", "一个", "什么", "我想", "想找", "找", "记得", "有一", "有没有", "帮我",
  "看看", "看下", "觉得", "好像", "大概", "左右", "那种", "这种", "里面", "内容", "讲的视频",
  "up", "主", "up主", "作者", "b站", "bilibili",
]);

/** 中文数字 → 阿拉伯数字（只处理时长/数量里会出现的 1–99）。 */
const CN = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
export function parseCnNumber(text) {
  const s = String(text || "");
  if (/^\d+$/.test(s)) return Number(s);
  if (s === "十") return 10;
  const m = s.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? CN[m[1]] : 1) * 10 + (m[2] ? CN[m[2]] : 0);
  if (s.length === 1 && CN[s] != null) return CN[s];
  return null;
}

const asciiTokens = (s) => [...s.matchAll(/[A-Za-z][A-Za-z0-9._+-]*[A-Za-z0-9]|[A-Za-z]{2,}/g)]
  .map((m) => m[0].toLowerCase())
  .filter((t) => t.length >= 2 && !/^\d+$/.test(t));

/** 中文 2–4 元组；2 元组噪声大，只用于打分，不用于硬约束。 */
function cjkGrams(s, ns = [2, 3, 4]) {
  const out = new Set();
  for (const seg of s.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const text = seg[0];
    for (const n of ns) {
      for (let i = 0; i + n <= text.length; i++) out.add(text.slice(i, i + n));
    }
  }
  return [...out];
}

/** 时长：3-5 分钟 / 10 分钟左右 / 半小时 / 20 分钟以上 / 1 小时以内。 */
export function parseDuration(text) {
  const s = String(text || "");
  const hour = s.match(/(\d+(?:\.\d+)?)\s*(?:小时|h)\s*(以内|以下|以上)?/i);
  let min = null, max = null;
  const range = s.match(/(\d+|[一二两三四五六七八九十]+)\s*(?:-|–|~|～|到|至)\s*(\d+|[一二两三四五六七八九十]+)\s*分钟/);
  const single = s.match(/(\d+|[一二两三四五六七八九十]+)\s*分钟\s*(左右|上下|以上|以下|以内)?/);
  const half = /半小时/.test(s);
  if (range) {
    min = parseCnNumber(range[1]); max = parseCnNumber(range[2]);
  } else if (half) {
    if (/以上/.test(s)) { min = 25; max = null; }
    else if (/以内|以下/.test(s)) { min = 0; max = 35; }
    else { min = 25; max = 35; }
  } else if (single) {
    const n = parseCnNumber(single[1]), unit = single[2] || "左右";
    if (!Number.isFinite(n)) return null;
    if (unit === "以上") { min = n; max = null; }
    else if (unit === "以下" || unit === "以内") { min = 0; max = n; }
    else { min = Math.max(0, Math.round(n * 0.6)); max = Math.round(n * 1.6); }
  } else if (hour) {
    const n = Number(hour[1]) * 60, unit = hour[2] || "左右";
    if (unit === "以上") { min = n; max = null; }
    else if (unit === "以下" || unit === "以内") { min = 0; max = n; }
    else { min = Math.round(n * 0.6); max = Math.round(n * 1.6); }
  }
  if (min == null && max == null) return null;
  return { min: min ?? 0, max: max ?? null };
}

/** 时间窗：最近 3 天 / 一周 / 一个月 / 今年 / 去年 / 2026 年。 */
export function parseSince(text, now = Date.now()) {
  const s = String(text || "");
  const day = 86400_000;
  let m = s.match(/最近\s*(\d+|[一二两三四五六七八九十]+)\s*(天|日|周|星期|个月|月|年)/);
  if (m) {
    const n = parseCnNumber(m[1]) ?? 1, unit = m[2];
    const ms = unit === "天" || unit === "日" ? n * day
      : unit === "周" || unit === "星期" ? n * 7 * day
        : unit === "个月" || unit === "月" ? n * 30 * day : n * 365 * day;
    return now - ms;
  }
  if (/最近\s*(一周|一个星期)/.test(s)) return now - 7 * day;
  if (/最近\s*(一个月|1个月)/.test(s)) return now - 30 * day;
  if (/今年/.test(s)) return new Date(new Date(now).getFullYear(), 0, 1).getTime();
  if (/去年/.test(s)) return new Date(new Date(now).getFullYear() - 1, 0, 1).getTime();
  m = s.match(/(20\d{2})\s*年/);
  if (m) return new Date(Number(m[1]), 0, 1).getTime();
  return null;
}

/** 「示例作者讲的」「@示例作者」→ UP 名。 */
export function parseUp(text) {
  const s = String(text || "");
  const at = s.match(/@([^\s，。、,]{2,20})/);
  if (at) return at[1];
  const m = s.match(/([^\s，。、,]{2,20})\s*(?:讲的|说的|出的|做的|那个 UP|up)/i);
  if (m && !STOP.has(m[1])) return m[1];
  return null;
}

/** 引号里的内容当作必须原样命中的短语。 */
export function parseQuotes(text) {
  return [...String(text || "").matchAll(/[「"“]([^」"”]{2,40})[」"”]/g)].map((m) => m[1].trim());
}

/** 去掉口水词与单字助词；先删长词，避免"讲的视频"被拆成"讲"+"的"残留。 */
export function denoise(text) {
  let s = String(text || "");
  for (const w of [...STOP].sort((a, b) => b.length - a.length)) s = s.split(w).join(" ");
  s = s.replace(/[的了呢吧啊嘛哦呀是在里和与跟把被给对从就都也还又]/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

/**
 * 主入口：把一句话拆成 {keyword, ascii[], cjk[], must[], mustNot[], duration, since, up}。
 * keyword 是给站内搜索用的清洗版；must 是硬约束（命不中就落到"最接近"里）。
 */
export function parseQuery(raw, { now = Date.now() } = {}) {
  const original = String(raw || "").trim();
  let text = original.replace(/\s+/g, " ");
  const quotes = parseQuotes(text);
  const up = parseUp(text);
  const duration = parseDuration(text);
  const since = parseSince(text, now);

  // 去掉时间/时长/UP 的口语片段，剩下的当关键词
  let cleaned = text
    .replace(/[「"“][^」"”]{2,40}[」"”]/g, " ")
    .replace(/最近\s*(\d+|[一二两三四五六七八九十]+)\s*(天|日|周|星期|个月|月|年)/g, " ")
    .replace(/今年|去年|20\d{2}\s*年/g, " ")
    .replace(/(\d+|[一二两三四五六七八九十]+)\s*(?:-|–|~|～|到|至)\s*(\d+|[一二两三四五六七八九十]+)\s*分钟/g, " ")
    .replace(/(\d+|[一二两三四五六七八九十]+)\s*分钟\s*(左右|上下|以上|以下|以内)?/g, " ")
    .replace(/半小时|1\s*小时|一小时\s*(左右|以内|以下|以上)?/g, " ")
    .replace(/@([^\s，。、,]{2,20})/g, " ")
    .replace(/([^\s，。、,]{2,20})\s*(?:讲的|说的|出的|做的)/g, " ")
    .replace(/[，。、,；;！!？?~～]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  cleaned = denoise(cleaned);

  const ascii = [...new Set([...asciiTokens(original), ...quotes.flatMap((q) => asciiTokens(q))])];
  const cjk = cjkGrams(cleaned || original, [2, 3, 4]).filter((g) => !STOP.has(g));
  const must = [...quotes, ...ascii.filter((t) => t.length >= 3)];
  // 中心词：中文修饰语在前、中心语在后，「的」之后通常是真正的检索对象
  // （四个层级的**工作边界**）。denoise 会把「的」删掉，所以从原句取。
  const focus = (() => {
    const at = original.lastIndexOf("的");
    if (at < 0) return "";
    const tail = original.slice(at + 1).replace(/[的了呢吧啊嘛哦呀，。、,；;！!？?~～]/g, "").trim();
    return tail.length >= 2 && tail.length <= 10 && !STOP.has(tail) ? tail : "";
  })();
  return {
    raw: original, keyword: cleaned || quotes.join(" ") || original, quotes, up, duration, since, ascii, cjk, focus,
    must: [...new Set(must.map((t) => t.toLowerCase()))],
    // 备注：中文整句不做硬约束——"四层工作边界"和"四层 PCB"共享 2 元组，硬卡只会漏
    stopwords: [...STOP],
  };
}
