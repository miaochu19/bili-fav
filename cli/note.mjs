#!/usr/bin/env node
// 素材打包 / 写笔记 / 重建索引 / 工作清单
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { FILES, DATA, VAULT, ensureDirs, rel } from "../lib/paths.mjs";
import { readJson, writeJsonAtomic, writeTextAtomic } from "../lib/fsx.mjs";
import { loadCookies } from "../lib/cookies.mjs";
import { BiliApi } from "../lib/api.mjs";
import { buildPacket, packetPath, buildWorklist, estimateCost } from "../lib/pack.mjs";
import { writeNote, rebuildIndex, loadNotes, archiveCover } from "../lib/note.mjs";
import { fmtClock } from "../lib/media.mjs";
import { citedTimestamps, bodyChars, bodyMetrics, noteBody, noteBudget, citationAudit } from "../lib/quality.mjs";
import { readingArtifacts, saveOutline, transcriptDocument } from "../lib/outline.mjs";
import { UserInputError, cliError } from "../lib/errors.mjs";
import { audienceDescription } from "../lib/audience-materials.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0] || "help";
const rest = argv.slice(1);
function flag(name, fallback) {
  const i = rest.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = rest[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c("2"), bold = c("1"), green = c("32"), yellow = c("33"), red = c("31");

/** 评论区依据的固定标记：write 自动加，verify 检查，缺了就报错。 */
const COMMENTS_ONLY_MARK = "> [!warning] 仅基于评论区，未观看视频本体";

function extractBv(input) {
  const m = String(input || "").match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : String(input || "");
}

async function apiWithCookies() {
  const { cookies } = await loadCookies({ credPath: flag("cred") });
  const api = new BiliApi({ cookies, log: (m) => console.log(dim(m)) });
  await api.init();
  return api;
}

async function touchState(bvid, patch) {
  const state = (await readJson(FILES.state, {})) || {};
  const notes = (await readJson(FILES.notes, {})) || {};
  if (notes[bvid] && patch.status === "packed") patch = { ...patch, status: "written", note: notes[bvid].path };
  state[bvid] = { ...(state[bvid] || {}), ...patch, at: new Date().toISOString() };
  await writeJsonAtomic(FILES.state, state);
}

// ---------------------------------------------------------------- pack
async function pack() {
  const bvid = extractBv(rest[0]);
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) throw new UserInputError("用法：node cli/note.mjs prepare <有效 BV 号>");
  if (rest.includes("--danmaku") && rest.includes("--no-danmaku")) throw new UserInputError("--danmaku 与 --no-danmaku 不能同时使用");
  const commentsOnly = rest.includes("--comments-only");
  // 只看评论区时必须够量：默认 150 条（≈8 页），够看清观众在争什么；普通模式仍默认 5 条热评。
  const commentArg = flag("comments", commentsOnly ? "150" : "5");
  const comments = typeof commentArg === "string" && /^(all|全部|-1|\*)$/i.test(commentArg.trim()) ? Infinity : Number(commentArg);
  if (commentArg === true || !(comments === Infinity || Number.isInteger(comments) && comments >= 0 && comments <= 1000))
    throw new UserInputError("--comments 必须是 0–1000 或 all");
  const commentsMode = String(flag("comments-mode", "all"));
  const maxCommentPages = Number(flag("max-comment-pages", 80));
  if (!["hot", "time", "all"].includes(commentsMode)) throw new UserInputError("--comments-mode 必须是 hot / time / all");
  if (!Number.isInteger(maxCommentPages) || maxCommentPages < 1 || maxCommentPages > 200)
    throw new UserInputError("--max-comment-pages 必须是 1–200");
  if (commentsOnly && comments < 1) throw new UserInputError("--comments-only 至少需要 --comments 1");
  noteBudget(0, { depth: flag("depth", "auto") });
  const api = rest.includes("--offline") ? null : await apiWithCookies();
  const favs = await readJson(FILES.favs, null);
  const packet = await buildPacket(api, bvid, {
    favs,
    asr: rest.includes("--asr"),
    forceAsr: rest.includes("--force-asr"),
    refresh: rest.includes("--refresh"), offline: rest.includes("--offline"),
    depth: flag("depth", "auto"),
    commentsOnly,
    comments,
    commentsMode,
    maxCommentPages,
    danmaku: commentsOnly ? rest.includes("--danmaku") : !rest.includes("--no-danmaku"),
    asrModel: flag("model"),
    maxAsrMinutes: Number(flag("max-asr-minutes", 60)),
    log: (m) => console.log(dim(`  · ${m}`)),
  });
  await touchState(bvid, { status: "packed", title: packet.view.title });
  printPacket(packet);
}

async function outline() {
  const bvid = extractBv(rest[0]), packet = await readJson(packetPath(bvid), null);
  if (!packet) throw new Error("先 prepare/pack 生成 packet");
  if (!packet.materials?.transcript) throw new UserInputError("没有可用文字，不能生成或导入语义提纲");
  const dir = join(packetPath(bvid), "..");
  packet.writing = noteBudget(packet.view.duration, { depth: packet.writing?.depth || "auto" });
  const from = flag("from");
  if (from !== undefined) {
    if (typeof from !== "string") throw new Error("--from 需要提纲 JSON 文件");
    await saveOutline(await readJson(from), packet, dir);
    packet.workflow = { ...packet.workflow, stage: "outlined", next: "draft_then_verify" };
  }
  Object.assign(packet.materials, await readingArtifacts(packet, dir));
  await writeJsonAtomic(packetPath(bvid), packet);
  console.log(from ? `已保存可复用提纲：${packet.materials.outline}` : `填写模板后用 --from 导入：${packet.materials.outlineTemplate}`);
}

async function excerpt() {
  const bvid = extractBv(rest[0]), packet = await readJson(packetPath(bvid), null);
  if (!packet) throw new Error("缺少 packet");
  const doc = await transcriptDocument(packet), ids = flag("ids");
  let selected;
  if (typeof ids === "string") {
    const wanted = ids.split(",").map((s) => s.trim());
    selected = wanted.map((id) => doc.segments.find((s) => s.id === id));
    if (selected.some((s) => !s)) throw new Error("引用的段号不存在；核对当前文字指纹");
  } else {
    const from = Number(flag("from", 0)), to = Number(flag("to", from + 30));
    if (!(Number.isFinite(from) && Number.isFinite(to) && from >= 0 && to > from)) throw new Error("无效回读时间窗");
    selected = doc.segments.filter((s) => s.from < to && s.to > from);
  }
  console.log(JSON.stringify({ bvid, transcriptSha256: doc.sha256, segments: selected }, null, 2));
}

function printPacket(packet) {
  const m = packet.materials;
  console.log(`\n${bold(packet.view.title)}`);
  console.log(`  ${dim("BV")} ${packet.bvid}　${dim("时长")} ${fmtClock(packet.view.duration)}　${dim("UP")} ${packet.view.owner?.name}`);
  const subLabel = m.asr
    ? `本地转写 ${m.subtitleCount} 段`
    : `${m.subtitleCount} 行 · ${m.subtitleLang}`;
  console.log(`  ${dim("字幕")} ${m.transcript ? green(`${subLabel} → ${rel(m.transcript)}`) : yellow("无（可加 --asr 本地转写）")}`);
  const desc = String(packet.view?.desc || "").replace(/\s+/g, " ").trim();
  console.log(`  ${dim("简介")} ${desc ? `${desc.length} 字，必读${m.description ? ` → ${rel(m.description)}` : ""}：${desc.slice(0, 40)}…` : yellow("（该视频没有简介）")}`);
  console.log(`  ${dim("拼图")} ${m.sheets.length ? green(`${m.sheets.length} 张 → ${rel(m.sheetsDir)}`) : dim("未生成；文字充分时可跳过，型号/参数/硬字幕按需回读")}`);
  console.log(`  ${dim("弹幕")} ${audienceDescription(packet, "danmaku")}`);
  console.log(`  ${dim("评论")} ${audienceDescription(packet, "comments")}`);
  const basis = packet.evidence?.basis;
  if (basis) console.log(`  ${dim("依据")} ${basis === "comments_only" ? yellow("仅评论区（未看片，写笔记须加 --basis comments_only）") : basis === "transcript" ? green("有文字稿") : dim("仅元数据")}`);
  if (m.charsPerSec) console.log(`  ${dim("语速")} ${m.charsPerSec} 字/秒${m.charsPerSec >= 1.5 && m.charsPerSec <= 9 ? green(" ✓") : yellow(" ⚠")}`);
  for (const w of m.warnings || []) console.log(`  ${yellow("!")} ${w}`);
  console.log(`  ${dim("素材包")} ${rel(packetPath(packet.bvid))}`);
  if (m.readingGuide) console.log(`  阅读入口 ${rel(m.readingGuide)}`);
  console.log(dim(`\n  下一步：读入口与带段号原文 → 保存 outline → 写自由体笔记；画面按需回读。\n`));
}

// ---------------------------------------------------------------- write
async function write() {
  const bvid = extractBv(rest[0]);
  const bodyFile = flag("body");
  if (!bvid || typeof bodyFile !== "string") {
    console.error(red("用法：node cli/note.mjs write <BV> --body <markdown文件> [--tags a,b] [--rating 4]"));
    process.exitCode = 1;
    return;
  }
  const packet = await readJson(packetPath(bvid), null);
  if (!packet) {
    console.error(red(`没有素材包 ${rel(packetPath(bvid))}，先跑 pack`));
    process.exitCode = 1;
    return;
  }
  const body = await readFile(bodyFile, "utf8");
  if (!body.trim()) { console.error(red("正文是空的")); process.exitCode = 1; return; }
  if (packet.materials?.transcriptSha256 && (await transcriptDocument(packet)).sha256 !== packet.materials.transcriptSha256)
    throw new Error("文字素材已变动，先 prepare/outline 更新阅读依据，再写入笔记");
  const budget = noteBudget(packet.view?.duration, { depth: flag("depth", packet.writing?.depth || "auto") });
  const count = bodyChars(body);
  if (count > budget.maxChars && !rest.includes("--allow-long")) {
    throw new Error(`正文 ${count} 字超过上限 ${budget.maxChars}，超了 ${count - budget.maxChars} 字；请压缩，确需保留可用 --allow-long`);
  }

  const tags = String(flag("tags", "")).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  const ratingRaw = flag("rating");
  const rating = ratingRaw ? Number(ratingRaw) : null;
  if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) throw new Error("rating 需为 1–5");
  const kind = flag("kind", "summary");
  if (!["summary", "visual_only", "advertisement", "invalid"].includes(kind)) throw new Error("无效 note kind");

  // 依据来源：评论区优先时必须留下"我没看片"的永久标记，且不许出现时间戳引用
  const basis = String(flag("basis", packet.evidence?.basis === "comments_only" ? "comments_only" : "transcript"));
  if (!["transcript", "comments_only", "mixed"].includes(basis)) throw new Error("--basis 必须是 transcript / comments_only / mixed");
  let finalBody = body;
  if (basis === "comments_only") {
    const n = packet.materials?.comments?.length || 0;
    if (!n) throw new Error("没有评论材料：先 prepare --comments-only --comments N，再写评论依据的笔记");
    if (!body.includes(COMMENTS_ONLY_MARK)) {
      finalBody = `${COMMENTS_ONLY_MARK}\n> 以下内容全部来自 B 站评论区（共 ${n} 条）的观众说法，未观看视频本体、未核对原片；不能当作视频内容或作者原话引用。\n\n${body.trim()}\n`;
    }
    for (const warning of ["评论区样本只代表发言者，可能是少数意见；争议点应回到原片核对"]) console.log(yellow(warning));
  }
  const audit = citationAudit(finalBody, packet.view.duration, { kind });
  if (audit.errors.length) throw new Error(audit.errors.join("；"));
  // 评论区依据的笔记本来就没有时间锚，别拿"缺 3 个时间戳"去逼它编
  for (const warning of audit.warnings.filter((w) => !(basis === "comments_only" && /时间戳|时间锚/.test(w)))) console.log(yellow(warning));
  if (basis === "comments_only" && audit.values.length) console.log(yellow(`以评论区为依据却出现了 ${audit.values.length} 个时间戳引用，确认它们不是编的`));

  const { absPath, relPath } = await writeNote({ packet, body: finalBody, tags, rating, summaryDepth: budget.depth, noteKind: kind,
    evidenceBasis: basis, watched: basis !== "comments_only",
    budgetOverride: rest.includes("--allow-long"), assets: packet.materials?.sheets || [] });
  await touchState(bvid, { status: "written", title: packet.view?.title, note: relPath });
  console.log(`${green("✓")} ${relPath}`);
  console.log(dim(`  ${absPath}`));
}

// ---------------------------------------------------------------- index
async function index() {
  const favs = await readJson(FILES.favs, null);
  if (!favs) { console.error(red("没有 data/favs.json，先 node cli/fav.mjs fetch --all")); process.exitCode = 1; return; }
  const r = await rebuildIndex({ favs });
  console.log(`${green("✓")} ${rel(r.out)}`);
  console.log(`  已整理 ${r.done} / 共 ${r.total}，待整理 ${r.pending}，标签 ${r.tags} 个`);
}

// ---------------------------------------------------------------- verify
/**
 * 笔记质检：结构、时间戳越界、链接完整性、长度。
 * 这是"看起来对但其实是编的"最后一道闸。
 */
async function verify() {
  const bvid = extractBv(rest[0]);
  const notes = await loadNotes();
  const meta = notes[bvid];
  if (!meta) {
    console.error(red(`没有 ${bvid} 的笔记记录`));
    process.exitCode = 1;
    return;
  }
  const file = join(VAULT, meta.path);
  if (!existsSync(file)) {
    console.error(red(`笔记文件不存在：${meta.path}`));
    process.exitCode = 1;
    return;
  }
  const text = await readFile(file, "utf8");
  const packet = await readJson(packetPath(bvid), null);
  const duration = packet?.view?.duration || meta.duration || 0;

  const errors = [];
  const warnings = [];

  if (!/^---\r?\n[\s\S]*?\r?\n---/.test(text)) errors.push("缺 frontmatter");
  if (!new RegExp(`bvid:\\s*${bvid}`).test(text)) errors.push("frontmatter 缺 bvid");

  // Free prose, no fixed section/rating/tag/quote requirements.
  const body = noteBody(text);
  const field = (name) => text.match(new RegExp("^" + name + ":\\s*([^\\r\\n]+)", "m"))?.[1]?.replace(/^"|"$/g, "");
  // 评论区依据的笔记必须自带"没看片"标记，且 frontmatter 不许声称看过
  const basis = field("evidence_basis") || "transcript";
  if (basis === "comments_only") {
    if (!text.includes(COMMENTS_ONLY_MARK)) errors.push(`评论区依据的笔记缺标记「${COMMENTS_ONLY_MARK}」`);
    if (!/^watched:\s*false/m.test(text)) errors.push("评论区依据的笔记必须写 watched: false");
  } else if (basis === "mixed" && !/^watched:\s*false/m.test(text)) {
    warnings.push("basis=mixed 但 watched 不是 false：确认是否真的看过原片");
  }
  const audit = citationAudit(body, duration, { kind: field("note_kind") || "summary" });
  errors.push(...audit.errors);
  warnings.push(...audit.warnings.filter((w) => !(basis === "comments_only" && /时间戳|时间锚/.test(w))));
  const count = audit.values.length, maxTs = Math.max(0, ...audit.values);
  const depth = field("summary_depth") || (duration > 1800 ? "legacy" : "auto");
  const chars = bodyChars(body);
  // 长度按片长分档：信息密度高的长视频允许更长，短切片压到 900 以内
  const { maxChars } = noteBudget(duration, { depth });
  if ((field("note_kind") || "summary") === "summary" && chars < (depth === "shallow" ? 80 : 200)) warnings.push(`正文偏短（${chars} 字），不要为凑数注水`);
  if (chars > maxChars) warnings.push(`正文偏长（${chars} 字），该片长上限 ${maxChars}`);

  // 拼图链接是否真的存在
  const links = [...text.matchAll(/!\[\[([^\]]+)\]\]/g)].map((x) => x[1]);
  for (const link of links) {
    const abs = join(VAULT, link.replace(/\//g, "\\"));
    if (!existsSync(abs)) errors.push(`图片链接失效：${link}`);
  }

  const mark = (ok) => (ok ? green("✓") : red("✗"));
  console.log(`\n${bold("质检")} ${bvid}  ${dim(meta.path)}\n`);
  console.log(`  ${mark(!errors.length)} 结构        ${errors.length ? errors.join("；") : "通过"}`);
  console.log(`  ${mark(!warnings.length)} 提示        ${warnings.length ? warnings.join("；") : "无"}`);
  console.log(`  ${dim("时间戳")}      ${count} 个，最大 ${fmtClock(maxTs)} / 视频 ${fmtClock(duration)}`);
  console.log(`  ${dim("正文")}        ${chars} 字`);
  console.log(`  ${dim("图片")}        ${links.length} 个引用`);
  console.log();
  if (errors.length || rest.includes("--strict") && warnings.length) process.exitCode = 1;
}

// ---------------------------------------------------------------- plan
async function plan() {
  const { favs, pending, done } = await buildWorklist();
  if (!favs) { console.error(red("没有 data/favs.json，先 fetch")); process.exitCode = 1; return; }
  const n = Number(flag("n", 10));
  const minMin = Number(flag("min-minutes", 0));
  const maxMin = Number(flag("max-minutes", 0));
  const recentDays = Number(flag("recent-days", 0)), topic = flag("topic");
  if (!Number.isInteger(n) || n < 1 || !Number.isFinite(recentDays) || recentDays < 0) throw new Error("无效的 n/recent-days");
  let pool = pending;
  if (minMin > 0) pool = pool.filter((v) => (v.duration || 0) >= minMin * 60);
  if (maxMin > 0) pool = pool.filter((v) => (v.duration || 0) <= maxMin * 60);
  if (recentDays > 0) pool = pool.filter((v) => (v.favTime || 0) >= Date.now() / 1000 - recentDays * 86400);
  const topics = (await readJson(join(DATA, "topics.json"), null))?.assign || {};
  if (typeof topic === "string") pool = pool.filter((v) => topics[v.bvid] === topic);
  const batch = pool.slice(0, n);
  if (rest.includes("--json")) {
    console.log(JSON.stringify({ pending: pending.length, pool: pool.length, selected: batch.map((v) => ({
      bvid: v.bvid, title: v.title, up: v.up, duration: v.duration, favTime: v.favTime, topic: topics[v.bvid] || "未分类",
      estimate: estimateCost(v), writing: noteBudget(v.duration),
    })) }, null, 2));
    return;
  }

  console.log(`\n${bold("工作清单")}　共 ${favs.videos.length}，已整理 ${done.length}，待整理 ${pending.length}（本批池 ${pool.length}）\n`);
  if (!pool.length) { console.log(green("  这个条件下没有待处理的视频。")); return; }

  let mb = 0, sheets = 0, minutes = 0;
  for (const v of batch) {
    const e = estimateCost(v);
    mb += e.mb; sheets += e.sheets; minutes += e.minutes;
    console.log(`  ${dim("·")} ${v.bvid} ${v.title.slice(0, 46).padEnd(46)} ${fmtClock(v.duration).padStart(7)}  ~${e.mb}MB  图 ${e.sheets}/${e.maxSheets}（预计/上限）`);
  }
  console.log(`\n  这一批 ${batch.length} 个：约 ${minutes} 分钟素材、${mb} MB 下载、${sheets} 张拼图。`);
  console.log(dim(`  跑：node cli/batch.mjs pack --n ${n}\n`));
}

// ---------------------------------------------------------------- list
async function list() {
  const notes = await loadNotes();
  const all = Object.values(notes)
    .filter((n) => existsSync(join(VAULT, n.path)))
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  if (!all.length) { console.log(yellow("还没有任何笔记。")); return; }
  console.log(`\n已整理 ${all.length} 个\n`);
  for (const n of all) {
    console.log(`  ${(n.rating ? "★".repeat(n.rating) : "—").padEnd(6)} ${n.title}`);
    console.log(`          ${dim(`${n.folder} · ${fmtClock(n.duration)} · ${(n.tags || []).join(" ") || "无标签"}`)}`);
  }
  console.log();
}

async function covers() {
  const notes = await loadNotes(), backup = join(DATA, "backups", `covers-${Date.now()}`);
  let archived = 0, failed = 0;
  for (const [bvid, note] of Object.entries(notes)) {
    const file = join(VAULT, note.path);
    const text = await readFile(file, "utf8");
    const match = text.match(/^cover:\s*(.+)$/m);
    const value = match?.[1]?.trim();
    const url = value?.startsWith('"') ? JSON.parse(value) : value;
    if (!url || !/^https?:\/\//.test(url)) continue;
    if (rest.includes("--dry")) { console.log(`待本地化 ${bvid}`); continue; }
    try {
      const cover = await archiveCover({ bvid, view: { pic: url } });
      await writeTextAtomic(join(backup, `${bvid}.md`), text);
      let next = text.replace(/^cover:.*$/m, `cover: ${cover}`);
      if (!/^cover_url:/m.test(next)) next = next.replace(/^cover:.*$/m, (line) => line + `\ncover_url: ${JSON.stringify(url)}`);
      next = next.replace(/(## 原始素材\s*\r?\n)/, `$1\n- 封面：![[${cover}]]\n`);
      await writeTextAtomic(file, next);
      archived++;
      console.log(`已本地化 ${bvid} → ${cover}`);
    } catch (err) { failed++; console.error(`${bvid}: ${err.message}`); }
  }
  console.log(`封面已本地化 ${archived}，失败 ${failed}`);
  if (failed) process.exitCode = 1;
}

const HELP = `
${bold("bili-fav note")} —— 素材打包与笔记归档

  node cli/note.mjs plan [--n 10]             看下一批做什么、预估成本
  node cli/note.mjs plan --topic AI/大模型 --recent-days 2 --min-minutes 3 --max-minutes 30 --json
  node cli/note.mjs prepare <BV>              推荐入口，缓存优先 → READING.md / 段号原文 / 提纲模板
  node cli/note.mjs pack <BV>                 prepare 的兼容别名，选项及默认行为一致
    默认取弹幕（--danmaku）及最多 5 条热评；--no-danmaku / --comments 0 停止本次请求，保留已有材料
    --comments 0-1000|all                      评论区条数；排序固定为 置顶 → UP 发言 → 点赞降序
    --comments-only [--comments 150]            只看评论区（默认 150 条；不取字幕/不转写/不生成拼图）
    --comments-mode hot|time|all                翻页口径（默认 all：先热度，不够再按时间补齐）
    --max-comment-pages 80                      翻页预算（每页 20 条；100 页 = 2000 条）
  node cli/note.mjs prepare <BV> --offline --comments 0  完全离线复用
  node cli/note.mjs outline <BV> [--from draft.json]  初始化/校验导入提纲
  node cli/note.mjs excerpt <BV> --ids L1,L2  按引用回读；也可 --from 60 --to 90
  node cli/note.mjs write <BV> --body <md>    写笔记（--tags a,b --rating 1-5）
  node cli/note.mjs index                     重建 vault/00-索引
  node cli/note.mjs list                      看已整理的笔记
  node cli/note.mjs verify <BV>               质检：结构 / 时间戳 / 链接 / 长度
  node cli/note.mjs covers [--dry]            将已有笔记封面本地化（备份旧笔记）
  --debug                                   错误时显示调试堆栈，默认只报原因和修正提示
`;

async function main() {
  ensureDirs();
  switch (cmd) {
    case "plan": await plan(); break;
    case "pack": case "prepare": await pack(); break;
    case "outline": await outline(); break;
    case "excerpt": await excerpt(); break;
    case "write": await write(); break;
    case "index": await index(); break;
    case "list": await list(); break;
    case "verify": await verify(); break;
    case "covers": await covers(); break;
    default: console.log(HELP);
  }
}

main().catch((err) => {
  console.error(red(cliError(err, { debug: rest.includes("--debug") })));
  process.exitCode = 1;
});
