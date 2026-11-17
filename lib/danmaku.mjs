// 弹幕正文：严格解析 + 按窗口/关键词回读 + 有界展示。
// 只读接口返回的 XML；不请求额外接口，不把解析失败当成「零弹幕」。
const MAX_XML_BYTES = 8 * 1024 * 1024;
const NAME = /^[A-Za-z_][\w.:-]*/;
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

const bad = (message) => { throw new Error(message); };

function decodeEntities(text, fail) {
  return text.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/g, (all, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) fail(`无效字符引用 ${all}`);
      return String.fromCodePoint(code);
    }
    if (!(body in ENTITIES)) fail(`不接受未声明的实体 ${all}`);
    return ENTITIES[body];
  });
}

function readTag(xml, start, fail) {
  let i = start + 1;
  const nameMatch = NAME.exec(xml.slice(i));
  if (!nameMatch) fail("标签名无效");
  const name = nameMatch[0];
  i += name.length;
  const attrs = {};
  for (;;) {
    while (i < xml.length && /\s/.test(xml[i])) i++;
    if (i >= xml.length) fail("标签未闭合");
    if (xml[i] === ">") return { name, attrs, selfClosing: false, end: i + 1 };
    if (xml[i] === "/" && xml[i + 1] === ">") return { name, attrs, selfClosing: true, end: i + 2 };
    const attrMatch = NAME.exec(xml.slice(i));
    if (!attrMatch) fail("属性名无效");
    const attr = attrMatch[0];
    i += attr.length;
    while (i < xml.length && /\s/.test(xml[i])) i++;
    if (xml[i] !== "=") fail(`属性 ${attr} 缺少 =`);
    i++;
    while (i < xml.length && /\s/.test(xml[i])) i++;
    const quote = xml[i];
    if (quote !== '"' && quote !== "'") fail(`属性 ${attr} 未加引号`);
    const end = xml.indexOf(quote, i + 1);
    if (end < 0) fail(`属性 ${attr} 未闭合`);
    attrs[attr] = decodeEntities(xml.slice(i + 1, end), fail);
    i = end + 1;
  }
}

/** 只接受弹幕接口那一种结构：根是 <i>，消息是 <d p="...">纯文本</d>。 */
function parseDocument(xml) {
  const root = { type: "element", name: "#document", children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      if (xml.slice(i).trim()) bad("XML 结尾有多余内容");
      break;
    }
    if (lt > i) {
      const text = decodeEntities(xml.slice(i, lt), bad);
      if (stack.length === 1 && text.trim()) bad("根节点之外有多余内容");
      top().children.push({ type: "text", value: text });
      i = lt;
    }
    if (xml.startsWith("<?", i)) {
      const end = xml.indexOf("?>", i);
      if (end < 0) bad("XML 声明未闭合");
      i = end + 2;
      continue;
    }
    if (xml.startsWith("<!--", i)) {
      const end = xml.indexOf("-->", i);
      if (end < 0) bad("注释未闭合");
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", i)) {
      const end = xml.indexOf("]]>", i);
      if (end < 0) bad("CDATA 未闭合");
      top().children.push({ type: "cdata", value: xml.slice(i + 9, end) });
      i = end + 3;
      continue;
    }
    if (xml.startsWith("</", i)) {
      const end = xml.indexOf(">", i);
      if (end < 0) bad("闭合标签未完成");
      const name = xml.slice(i + 2, end).trim();
      if (!NAME.test(name)) bad("闭合标签名无效");
      if (stack.length === 1) bad("多余的闭合标签");
      if (top().name !== name) bad(`闭合标签不匹配：</${name}> 对 <${top().name}>`);
      stack.pop();
      i = end + 1;
      continue;
    }
    const tag = readTag(xml, i, bad);
    const node = { type: "element", name: tag.name, attrs: tag.attrs, children: [] };
    top().children.push(node);
    if (!tag.selfClosing) stack.push(node);
    i = tag.end;
  }
  if (stack.length !== 1) bad("XML 不完整（有标签未闭合）");
  return root;
}

const elementChildren = (node) => node.children.filter((n) => n.type === "element");

/** 弹幕文本只允许文本/CDATA；出现嵌套标签就不当正文，避免把标记当内容。 */
function textOf(node) {
  return node.children.map((child) => {
    if (child.type === "text" || child.type === "cdata") return child.value;
    bad("弹幕文本包含不支持的嵌套标记");
  }).join("");
}

const clock = (sec) => {
  const ms = Math.round(sec * 1000), whole = Math.floor(ms / 1000);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
};

export const danmakuClock = clock;

/**
 * 解析弹幕 XML。cid 必须与 <chatid> 一致，否则视为拿错响应。
 * 返回的 rows 只保留时间与正文，丢弃发送者 hash、行号、发送时间等原始字段。
 */
export function parseDanmakuXml(xml, { cid, duration, bucketSec = 30, maxBytes = MAX_XML_BYTES } = {}) {
  const id = Number(cid);
  if (!Number.isSafeInteger(id) || id <= 0) bad("需要有效的 cid");
  if (!Number.isFinite(duration) || duration <= 0) bad("需要本 P 的有效时长");
  if (!Number.isFinite(bucketSec) || bucketSec <= 0) bad("时间桶必须为正数");
  const body = String(xml ?? "");
  if (!body.trim()) bad("弹幕 XML 是空的，不能当作零弹幕");
  if (Buffer.byteLength(body) > maxBytes) bad("弹幕 XML 超过大小上限");
  if (/<!DOCTYPE|<!ENTITY/i.test(body)) bad("不接受 DTD 或自定义实体");

  const document = parseDocument(body.replace(/^\uFEFF/, ""));
  const roots = elementChildren(document);
  if (roots.length !== 1 || roots[0].name !== "i") bad("响应不是弹幕 XML，不能当作零弹幕");
  const kids = elementChildren(roots[0]);
  const chatid = kids.find((n) => n.name === "chatid");
  if (!chatid) bad("弹幕 XML 缺少 chatid，不能确认属于这个视频");
  if (textOf(chatid).trim() !== String(id)) bad("弹幕 XML 的 chatid 与当前 cid 不匹配");

  const entries = kids.filter((n) => n.name === "d");
  const rows = [];
  const discarded = { invalidTime: 0, beyondDuration: 0, emptyText: 0 };
  for (const [index, node] of entries.entries()) {
    const rawTime = node.attrs?.p?.split(",")[0];
    const sec = Number(rawTime);
    const text = textOf(node).trim();
    if (rawTime == null || !String(rawTime).trim() || !Number.isFinite(sec) || sec < 0) { discarded.invalidTime++; continue; }
    if (sec > duration + 1) { discarded.beyondDuration++; continue; }
    if (!text) { discarded.emptyText++; continue; }
    rows.push({ id: `D${index + 1}`, sec, text });
  }
  rows.sort((a, b) => a.sec - b.sec || Number(a.id.slice(1)) - Number(b.id.slice(1)));

  const buckets = new Map();
  for (const row of rows) {
    const sec = Math.floor(row.sec / bucketSec) * bucketSec;
    buckets.set(sec, (buckets.get(sec) || 0) + 1);
  }
  return {
    cid: id, duration, bucketSec,
    status: entries.length ? "available" : "empty",
    rawCount: entries.length, usableCount: rows.length, discarded,
    peaks: [...buckets].sort((a, b) => a[0] - b[0]).map(([sec, n]) => ({ sec, n })),
    rows,
  };
}

/**
 * 有界回读：窗口 + 关键词 → 合并同文 → 沿时间分散取样 → 字符预算。
 * 默认不把上千条正文一次交给模型；需要细读时缩小窗口或加关键词。
 */
export function readDanmaku(parsed, { from = 0, to = (parsed?.duration ?? 0) + 1, query = "", limit = 24, maxChars = 4000 } = {}) {
  const duration = Number(parsed?.duration);
  if (!Number.isFinite(duration) || duration <= 0) bad("缺少本 P 时长，无法限定回读窗口");
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || to > duration + 1)
    bad("无效回读窗口（使用本 P 的绝对秒数）");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) bad("limit 必须为 1–200");
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 20000) bad("maxChars 必须为 1–20000");
  const needle = String(query ?? "").normalize("NFKC").toLowerCase();
  const matched = (parsed.rows || []).filter((r) => r.sec >= from && r.sec < to &&
    (!needle || r.text.normalize("NFKC").toLowerCase().includes(needle)));
  const groups = new Map();
  for (const row of matched) {
    const key = row.text.replace(/\s+/gu, " ");
    if (!groups.has(key)) groups.set(key, { text: row.text, firstSec: row.sec, lastSec: row.sec, occurrences: 1, ids: [row.id] });
    else {
      const g = groups.get(key);
      g.occurrences++;
      g.lastSec = row.sec;
      if (g.ids.length < 5) g.ids.push(row.id);
    }
  }
  const all = [...groups.values()];
  const count = Math.min(limit, all.length);
  // 均匀取样覆盖整段：窗口足够小时自然就是全部，不额外截断。
  const sampled = count === 0 ? [] : count === 1 ? [all[Math.floor(all.length / 2)]]
    : Array.from({ length: count }, (_, i) => all[Math.round(i * (all.length - 1) / (count - 1))]);
  const rows = [];
  let textChars = 0, skippedTooLong = 0;
  for (const row of sampled) {
    const n = [...row.text].length;
    if (textChars + n > maxChars) { skippedTooLong++; continue; }
    rows.push(row);
    textChars += n;
  }
  return {
    from, to, query: String(query ?? ""),
    matched: matched.length, distinctTexts: all.length,
    returned: rows.length, omittedDistinctTexts: all.length - rows.length, skippedTooLong, textChars,
    rows,
    note: "只合并空白差异的相同文本；出现次数不等于独立观众数，也不判定观点真假",
  };
}

/** 弹幕是未核实的观众发言：渲染成引用块，绝不改写成作者原话。 */
export function renderDanmakuReading({ bvid, title = "", cid, duration, fetchedAt = null, snapshot = null }, parsed, selection) {
  const lines = [
    `# 弹幕试读：${bvid}`,
    "",
    title || "",
    `CID: ${cid}；本 P ${duration} 秒${fetchedAt ? `；材料时间 ${fetchedAt}` : ""}${snapshot ? `；快照 ${String(snapshot).slice(0, 12)}` : ""}`,
    "来源：接口本次返回的弹幕池，未证明覆盖全部历史弹幕。以下是观众发言，不能当作者原话或视频内容。",
    "",
    `返回 ${parsed.rawCount} 条；可用 ${parsed.usableCount} 条；本次筛中 ${selection.matched} 条；合并后 ${selection.distinctTexts} 种文本；展示 ${selection.returned} 种。`,
    `窗口 [${selection.from}, ${selection.to}) 秒${selection.query ? `；关键词「${selection.query}」` : ""}；隐藏 ${selection.omittedDistinctTexts} 种文本`
      + `${selection.skippedTooLong ? `，其中 ${selection.skippedTooLong} 条因超长跳过` : ""}。${selection.note}`,
    "",
  ];
  for (const row of selection.rows) {
    const span = row.lastSec !== row.firstSec ? `–${clock(row.lastSec)}` : "";
    lines.push(`[${clock(row.firstSec)}${span}] ${row.ids.join(",")}；出现 ${row.occurrences} 次`);
    // 正文按代码块原样展示（含链接、命令、指令性文字），只当外部数据看。
    const longest = Math.max(2, ...[...row.text.matchAll(/`+/g)].map((m) => m[0].length));
    const fence = "`".repeat(longest + 1);
    lines.push(`${fence}text`, row.text, fence, "");
  }
  return lines.join("\n");
}
