import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { readJson, writeJsonAtomic, writeTextAtomic } from "./fsx.mjs";
import { digest } from "./material-cache.mjs";
import { parseTranscript, transcriptClock } from "./transcript.mjs";
import { UserInputError } from "./errors.mjs";
import { audienceDescription } from "./audience-materials.mjs";

export async function transcriptDocument(packet) {
  if (!packet.materials?.transcript) throw new UserInputError("没有可用文字，不能生成或导入语义提纲");
  const text = await readFile(packet.materials.transcript, "utf8");
  const segments = parseTranscript(text).map((s, i) => ({ id: `L${i + 1}`, ...s }));
  return { text, segments, sha256: digest(text) };
}

export function validateOutline(input, packet, document) {
  if (input?.version !== 1 || input.bvid !== packet.bvid || input.transcriptSha256 !== document.sha256)
    throw new UserInputError("提纲版本/BV/文字指纹不一致", { hint: `运行 node cli/note.mjs outline ${packet.bvid} 获取当前模板，回读原文后重新填写` });
  if (typeof input.summary !== "string" || [...input.summary].length > 400) throw new UserInputError("提纲 summary 需为不超过 400 字的字符串");
  if (!Array.isArray(input.chapters) || !input.chapters.length || input.chapters.length > 40) throw new UserInputError("提纲需要 1–40 个章节");
  const refs = new Map(document.segments.map((s) => [s.id, s]));
  let end = 0;
  for (const c of input.chapters) {
    if (!c || typeof c.title !== "string" || !c.title.trim() || !Number.isFinite(c.from) || !Number.isFinite(c.to) || c.from < end || c.to <= c.from || c.to > packet.view.duration + 1)
      throw new UserInputError("章节标题/时间窗无效或顺序重叠");
    end = c.to;
    if (!Array.isArray(c.points) || !c.points.length || c.points.length > 20) throw new UserInputError("每章需 1–20 个有依据的要点");
    for (const point of c.points) {
      if (!point || typeof point.text !== "string" || !point.text.trim() || !Array.isArray(point.segmentIds) || !point.segmentIds.length || point.segmentIds.some((id) => typeof id !== "string"))
        throw new UserInputError("要点必须有 text 与 segmentIds（字符串段号列表）");
      const cited = point.segmentIds.map((id) => refs.get(id));
      if (cited.some((s) => !s || s.from >= c.to || s.to <= c.from))
        throw new UserInputError(`提纲引用了不存在或章节窗口之外的字幕段（${point.segmentIds.join(",")}）`,
          { hint: `核对 transcript.indexed.txt 中的 L1–L${document.segments.length} 及章节时间窗` });
      const normalize = (s) => s.replace(/\s/g, "");
      if (point.quote != null && (typeof point.quote !== "string" || !normalize(cited.map((s) => s.text).join(" ")).includes(normalize(point.quote))))
        throw new UserInputError(`提纲 quote 并非所引字幕的原文（段 ${point.segmentIds.join(",")}）`,
          { hint: `建议回读：node cli/note.mjs excerpt ${packet.bvid} --ids ${point.segmentIds.join(",")}` });
    }
  }
  return { version: 1, bvid: packet.bvid, transcriptSha256: document.sha256, summary: input.summary,
    chapters: input.chapters, validation: "references_checked", generatedAt: new Date().toISOString() };
}

/** READING.md 里内联多少条评论；再多就只进 comments.md，避免阅读入口被评论淹掉。 */
export const COMMENTS_INLINE = 30;

const commentMarks = (c) => [c.tag ? `【${c.tag}】` : "", c.isUp ? "【UP】" : ""].filter(Boolean).join("");

/** 评论全文另存一份：条数上百时 READING.md 只内联最该看的，其余按需分段读。 */
async function writeCommentDump(packet, dir) {
  const comments = Array.isArray(packet.materials.comments) ? packet.materials.comments : [];
  if (!comments.length) return null;
  const info = packet.materials.commentsInfo || {};
  const cover = info.exhausted === true ? "（已翻到底）" : info.exhausted === false ? "（未翻到底）" : "";
  const collected = Number.isInteger(packet.materials.commentsCollected) ? packet.materials.commentsCollected : null;
  const head = [`# 观众评论（未核实）：${packet.view?.title || ""}`, "",
    `BV: ${packet.bvid} / aid ${packet.view?.aid ?? "?"} / 抓取 ${info.fetchedAt || "未知"}`,
    `排序：置顶 → UP 发言 → 点赞降序；本次 ${comments.length} 条`
      + `${collected && collected > comments.length ? `（已取到 ${collected} 条，按 --comments 截断）` : ""}`
      + `${packet.materials.commentsAvailable ? `；接口计 ${packet.materials.commentsAvailable} 条含楼中楼，仅作参考` : ""}${cover}`,
    "来源：B 站评论区（community_unverified）。高赞 ≠ 正确；置顶常是 UP 的带货位；UP 自己的话也不等于视频内容。", ""];
  const body = [];
  for (const [i, c] of comments.entries()) {
    body.push(`## ${i + 1}. ${commentMarks(c)}${c.like != null ? `♥${c.like} ` : ""}${c.name || "匿名"}${c.time ? ` · ${c.time}` : ""}`);
    body.push(String(c.text || "").replace(/\s+/g, " ").trim() || "（空）");
    for (const r of c.replyPreview || []) body.push(`  - ↳ ${r.isUp ? "【UP】" : ""}${r.name}：${r.text}`);
    const rest = Number(c.replies || 0) - (c.replyPreview?.length || 0);
    if (rest > 0) body.push(`  - ↳ 另有 ${rest} 条楼中楼未取（video.mjs comments --replies 可取）`);
    body.push("");
  }
  const file = join(dir, "comments.md");
  await writeTextAtomic(file, head.concat(body).join("\n"));
  return file;
}

export async function readingArtifacts(packet, dir) {
  const guide = join(dir, "READING.md");
  // 简介是作者自述的硬信息（仓库/版本/章节表/免责声明），必须进入阅读入口，不能只留在 packet 里。
  const desc = String(packet.view?.desc || "").replace(/\r\n?/g, "\n").trim();
  const DESC_INLINE = 900, described = desc.slice(0, DESC_INLINE);
  let descriptionFile = null;
  if (desc) {
    descriptionFile = join(dir, "description.txt");
    await writeTextAtomic(descriptionFile, `BV: ${packet.bvid}\n${packet.view?.title || ""}\n\n${desc}\n`);
  }
  const comments = Array.isArray(packet.materials.comments) ? packet.materials.comments : [];
  const commentFile = await writeCommentDump(packet, dir);
  const inline = comments.slice(0, COMMENTS_INLINE);
  const omitted = comments.length - inline.length;
  const commentLine = (c) => `- ${commentMarks(c)}${c.like != null ? `[赞 ${c.like}] ` : ""}${c.name ? `${c.name}：` : ""}${String(c.text || "").replace(/\s+/g, " ").trim()}`;
  const lines = [`# ${packet.view.title}`, "", `BV: ${packet.bvid} / 本 P 时长 ${transcriptClock(packet.view.duration)}`,
    `写作深度：${packet.writing.depth}；目标 ${packet.writing.targetChars}，正文上限 ${packet.writing.maxChars} 字（不计显式时间引用/Markdown 标记）`, "",
    "## 简介（作者自述，必读）",
    desc ? described + (described === desc ? "" : `\n\n…（完整简介 ${desc.length} 字，见 ${descriptionFile}）`) : "（该视频没有简介）", "",
    "## 观众评论（未核实，只作观众信号）",
    comments.length ? `排序：置顶 → UP 发言 → 点赞降序；抓取 ${comments.length} 条${omitted > 0 ? `，此处内联前 ${inline.length} 条，全文见 ${commentFile}` : ""}` : null,
    comments.length ? inline.map(commentLine).join("\n") : `- 没有可用评论：${audienceDescription(packet, "comments")}`,
    omitted > 0 ? `- …另有 ${omitted} 条未内联（全文见 ${commentFile}；UP 与高赞已排在最前）` : null,
    "- 评论能提示我听错的人名/型号/版本号，但不能当作者原话引用，也不能据此改写转写后冒充原文。", "",
    "## 先处理的事项", ...packet.materials.warnings.map((w) => `- ${w}`),
    "- 拼图按需：型号、参数截图、实物对比、硬字幕或文本不足时回读；有字幕也不等于已核对画面。", "",
    "## 观众材料状态", `- 弹幕：${audienceDescription(packet, "danmaku")}`,
    `- 评论：${audienceDescription(packet, "comments")}`,
    "- prepare 与 pack 默认取弹幕及最多 5 条热评；只看评论区（--comments-only）默认 150 条；--comments 0–1000 或 all，--comments-mode hot|time|all。",
    "- --no-danmaku / --comments 0 只停止本次请求，已有材料保留；未请求或获取失败不代表视频没有弹幕/评论。", ""
  ].filter((line) => line != null);
  if (!packet.materials.transcript) {
    lines.push("没有可用文字。检查隔离字幕，或显式申请本地 ASR；本文件不是内容摘要。");
    await writeTextAtomic(guide, lines.join("\n"));
    return { readingGuide: guide, description: descriptionFile, commentsFile: commentFile };
  }
  const doc = await transcriptDocument(packet);
  const indexedTranscript = join(dir, "transcript.indexed.txt");
  await writeTextAtomic(indexedTranscript, `BV: ${packet.bvid}\nSHA256: ${doc.sha256}\n\n` +
    doc.segments.map((s) => `[${s.id} ${transcriptClock(s.from)}-${transcriptClock(s.to)}] ${s.text}`).join("\n") + "\n");
  const template = join(dir, `outline.template-${doc.sha256.slice(0, 12)}.json`);
  const chunks = [];
  const duration = packet.view.duration, span = Math.max(60, Math.ceil(duration / 12 / 30) * 30);
  for (let from = 0; from < duration; from += span) {
    const to = Math.min(duration, from + span), ids = doc.segments.filter((s) => s.from < to && s.to > from).map((s) => s.id);
    if (ids.length) chunks.push({ from, to, segmentIds: ids });
  }
  if (!await readJson(template, null)) await writeJsonAtomic(template, { version: 1, bvid: packet.bvid,
    transcriptSha256: doc.sha256, summary: "", chapters: [], readingBlocks: chunks,
    instructions: "readingBlocks 仅为机械阅读分块。通读一次原文后填写有语义的 chapters:[{title,from,to,points:[{text,segmentIds:[L1],quote?:原话}]}]，另存 draft.json 后导入。" });
  let outline = null;
  const saved = await readJson(join(dir, "outline.json"), null).catch(() => null);
  if (saved) {
    try { outline = validateOutline(saved, packet, doc); }
    catch (err) { lines.push(`旧提纲已过期/无效：${err.message}。不得用它代替当前原文。`, ""); }
  }
  lines.push("## 阅读与复用", `原文：${packet.materials.transcript}`, `带段号的首次阅读文件：${indexedTranscript}`, `文字指纹：${doc.sha256}`,
    `提纲模板：${template}`, "首次通读原文，保存带 L 段号依据的提纲；后续改摘要先复用有效提纲，并回查所引用段。", "");
  if (outline) {
    lines.push("## 已保存的提纲（已校验引用，不代表自动核实观点）", outline.summary, "");
    for (const c of outline.chapters) lines.push(`- ${transcriptClock(c.from)}–${transcriptClock(c.to)} ${c.title}`,
      ...c.points.map((p) => `  - ${p.text} [${p.segmentIds.join(",")}]`));
  } else {
    lines.push("## 机械阅读地图（不是语义分章）", ...chunks.map((c) => `- ${transcriptClock(c.from)}–${transcriptClock(c.to)}：${c.segmentIds[0]}…${c.segmentIds.at(-1)}`));
  }
  lines.push("", "## 前 30 秒预览（仅帮助判断文本来源，不代表全片）",
    doc.segments.filter((s) => s.from < 30).map((s) => `[${s.id} ${transcriptClock(s.from)}] ${s.text}`).join("\n").slice(0, 800));
  await writeTextAtomic(guide, lines.join("\n") + "\n");
  return { readingGuide: guide, indexedTranscript, outlineTemplate: template, outline: outline ? join(dir, "outline.json") : null,
    description: descriptionFile, commentsFile: commentFile, transcriptSha256: doc.sha256 };
}

export async function saveOutline(input, packet, dir) {
  const outline = validateOutline(input, packet, await transcriptDocument(packet));
  await writeJsonAtomic(join(dir, "outline.json"), outline);
  return outline;
}
