/**
 * 服务层：CLI 与 DSH 插件共用的引擎。
 *
 * 约定：
 * - 只做业务，不打印；过程日志一律走 onLog 回调，错误用异常表达。
 * - 返回结构化对象，由调用方决定怎么展示（CLI 打终端 / 插件给模型）。
 * - 复用 lib 里已验证的模块，不重新实现抓取、打包、校验逻辑。
 */
import { open, readFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { CACHE, DATA, FILES, VAULT, ensureDirs } from "./paths.mjs";
import { readJson, writeJsonAtomic } from "./fsx.mjs";
import { loadCookies } from "./cookies.mjs";
import { BiliApi, NotLoggedInError } from "./api.mjs";
import { knownInFolder, mediaKey, mergeFolder } from "./favorites.mjs";
import { buildPacket, packetPath, buildWorklist, estimateCost } from "./pack.mjs";
import { writeNote, loadNotes, rebuildIndex } from "./note.mjs";
import { transcriptDocument } from "./outline.mjs";
import { fmtClock } from "./media.mjs";
import { bodyChars, citationAudit, noteBudget } from "./quality.mjs";
import { UserInputError } from "./errors.mjs";
import { digest } from "./material-cache.mjs";
import { parseQuery } from "./search-query.mjs";
import { dedupe, rankItems } from "./search-rank.mjs";
import { localRecall, relatedVideos, searchCache, searchSpace, searchUsers, searchVideos } from "./search-recall.mjs";
import { buildCorpusDf, buildInterestModel, hotFeed, rankFeed, rcmdFeed, scoreFeedItem, topicFeed, REGIONS } from "./feed.mjs";

/** 评论区依据的固定标记：write 自动加，verify 检查，缺了就报错。 */
export const COMMENTS_ONLY_MARK = "> [!warning] 仅基于评论区，未观看视频本体";

const BV_RE = /BV[0-9A-Za-z]{10}/;

/** 从任意文本里取 BV 号；取不到直接报输入错误。 */
export function extractBv(input) {
  const m = String(input || "").match(BV_RE);
  if (!m) throw new UserInputError("需要有效的 BV 号（形如 BV1xxxxxxxxx）");
  return m[0];
}

/** 带登录 Cookie 的 API 实例；不打印日志。 */
export async function openApi({ credPath } = {}) {
  const { cookies } = await loadCookies({ credPath });
  const api = new BiliApi({ cookies, log: () => {} });
  await api.init();
  return api;
}

// ---------------------------------------------------------------- 收藏库

/**
 * 抓取收藏夹（全量或增量）。返回抓取摘要，不打印。
 * incremental=true 时按收藏时间倒序，撞到已知条目提前收手。
 */
export async function refreshLibrary({ incremental = false, folder = null, credPath, onLog = () => {} } = {}) {
  ensureDirs();
  const api = await openApi({ credPath });
  const who = await api.whoami();
  if (!who) throw new UserInputError("需要登录才能读取收藏夹：先跑 node cli/fav.mjs login");

  const all = await api.myFolders(who.mid);
  const targets = folder
    ? all.filter((f) => String(f.id) === String(folder) || f.title === folder)
    : all;
  if (!targets.length) throw new UserInputError(`没选中任何收藏夹（folder=${folder ?? "未给"}）`);

  const prev = await readJson(FILES.favs, null);
  if (prev?.mid && String(prev.mid) !== String(who.mid)) {
    throw new Error("已有收藏属于另一账号，请先备份并移走 data/favs.json，避免混合账号数据");
  }

  const byBvid = new Map();
  if (prev?.videos) {
    for (const v of prev.videos) byBvid.set(mediaKey(v), structuredClone(v));
  }

  const folderStats = [];
  let stopped = false;
  for (const f of targets) {
    const known = knownInFolder(prev?.videos || [], f.id);
    let pages = 0;
    let got = 0;
    let fresh = 0;
    let stoppedEarly = false;
    onLog(`抓取 ${f.title}（声明 ${f.count} 条）`);
    try {
      const res = await api.favAll(f.id, {
        onPage: ({ total, pn }) => { pages = pn; got = total; },
        shouldStop: (page) => {
          if (!incremental || known.size === 0) return false;
          const newOnPage = page.medias.filter((m) => !known.has(mediaKey(m))).length;
          fresh += newOnPage;
          if (newOnPage === 0) { stoppedEarly = true; return true; }
          return false;
        },
      });
      mergeFolder(byBvid, res.medias, f, { complete: !stoppedEarly });
      folderStats.push({ id: f.id, title: f.title, declared: f.count, fetched: res.medias.length, pages });
      onLog(`${f.title}: ${res.medias.length} 条 / ${pages} 页${stoppedEarly ? `（增量 ${fresh} 个新，提前收手）` : ""}`);
    } catch (err) {
      folderStats.push({ id: f.id, title: f.title, declared: f.count, fetched: got, pages, error: err.message });
      onLog(`${f.title}: 失败 ${err.message}`);
      if (err instanceof NotLoggedInError) throw err;
      if (err.name === "RiskControlError") { stopped = true; break; }
      throw err;
    }
  }

  if (prev?.folders) {
    for (const f of prev.folders) if (!folderStats.some((x) => x.id === f.id)) folderStats.push(f);
  }

  const videos = [...byBvid.values()];
  const payload = {
    generatedAt: new Date().toISOString(),
    mid: who.mid,
    uname: who.uname,
    folders: folderStats,
    videos,
  };
  await writeJsonAtomic(FILES.favs, payload);

  const totalDur = videos.reduce((s, v) => s + (v.duration || 0), 0);
  return {
    uname: who.uname,
    mid: who.mid,
    total: videos.length,
    invalid: videos.filter((v) => v.invalid).length,
    hours: +(totalDur / 3600).toFixed(2),
    folders: folderStats.length,
    stoppedByRiskControl: stopped,
    generatedAt: payload.generatedAt,
  };
}

/** 收藏库统计；没有 favs.json 时返回 null（调用方决定怎么提示）。 */
export async function statsSummary() {
  const data = await readJson(FILES.favs, null);
  if (!data) return null;
  const videos = data.videos || [];
  const valid = videos.filter((v) => !v.invalid);
  const totalDur = valid.reduce((s, v) => s + (v.duration || 0), 0);
  const notes = (await readJson(FILES.notes, {})) || {};

  const byFolder = new Map(), byYear = new Map(), byUp = new Map();
  for (const v of valid) {
    for (const f of v.folders || []) byFolder.set(f.title, (byFolder.get(f.title) || 0) + 1);
    if (v.pubtime) {
      const y = new Date(v.pubtime * 1000).getFullYear();
      byYear.set(y, (byYear.get(y) || 0) + 1);
    }
    if (v.up) byUp.set(v.up, (byUp.get(v.up) || 0) + 1);
  }

  const noted = valid.filter((v) => notes[v.bvid]).length;
  return {
    generatedAt: data.generatedAt,
    uname: data.uname,
    mid: data.mid,
    total: videos.length,
    valid: valid.length,
    invalid: videos.length - valid.length,
    hours: +(totalDur / 3600).toFixed(1),
    noted,
    noteCoverage: valid.length ? +(noted / valid.length * 100).toFixed(1) : 0,
    byFolder: Object.fromEntries(byFolder),
    byYear: Object.fromEntries([...byYear].sort((a, b) => a[0] - b[0])),
    topUps: [...byUp].sort((a, b) => b[1] - a[1]).slice(0, 15),
  };
}

/** 工作清单：按收藏时间倒序挑下一批；返回选中项与预估成本。 */
export async function worklistSummary({ n = 10, minMinutes = 0, maxMinutes = 0, recentDays = 0, topic = null } = {}) {
  const { favs, pending, done } = await buildWorklist();
  if (!favs) return null;
  let pool = pending;
  if (minMinutes > 0) pool = pool.filter((v) => (v.duration || 0) >= minMinutes * 60);
  if (maxMinutes > 0) pool = pool.filter((v) => (v.duration || 0) <= maxMinutes * 60);
  if (recentDays > 0) pool = pool.filter((v) => (v.favTime || 0) >= Date.now() / 1000 - recentDays * 86400);
  const topics = (await readJson(join(DATA, "topics.json"), null))?.assign || {};
  if (topic) pool = pool.filter((v) => topics[v.bvid] === topic);
  const batch = pool.slice(0, n);
  return {
    total: favs.videos?.length || 0,
    done: done.length,
    pending: pending.length,
    pool: pool.length,
    selected: batch.map((v) => ({
      bvid: v.bvid,
      title: v.title,
      up: v.up,
      minutes: Math.round((v.duration || 0) / 60),
      topic: topics[v.bvid] || null,
      estimate: estimateCost(v),
    })),
  };
}

// ---------------------------------------------------------------- 单条视频

async function touchState(bvid, patch) {
  const state = (await readJson(FILES.state, {})) || {};
  const notes = (await readJson(FILES.notes, {})) || {};
  if (notes[bvid] && patch.status === "packed") patch = { ...patch, status: "written", note: notes[bvid].path };
  state[bvid] = { ...(state[bvid] || {}), ...patch, at: new Date().toISOString() };
  await writeJsonAtomic(FILES.state, state);
}

/** 把 packet 压缩成给模型看的证据摘要（不带全文，全文在本地文件）。 */
export function summarizePacket(packet) {
  const m = packet.materials || {};
  const info = (kind) => m[`${kind}Info`] || null;
  return {
    bvid: packet.bvid,
    title: packet.view?.title,
    up: packet.view?.owner?.name,
    duration: packet.view?.duration,
    multiPart: !!packet.multiPart,
    basis: packet.evidence?.basis || (m.transcript ? "transcript" : "metadata"),
    watched: Boolean(packet.evidence?.watched),
    transcript: m.transcript
      ? {
          available: true,
          source: m.asr ? "asr" : m.subtitleLang || "subtitle",
          segments: m.subtitleCount ?? 0,
          file: m.transcript,
          sha256: m.transcriptSha256 ?? null,
        }
      : { available: false, reason: (m.warnings || []).find((w) => /无可用文字/.test(w)) || null },
    description: { chars: String(packet.view?.desc || "").length, file: m.description || null },
    sheets: { count: m.sheets?.length || 0, dir: m.sheetsDir || null },
    danmaku: {
      status: info("danmaku")?.status || null,
      total: m.danmakuTotal ?? null,
      peaks: (packet.peaks || []).length,
      file: m.danmaku || null,
    },
    comments: {
      status: info("comments")?.status || null,
      count: (m.comments || []).length,
      exhausted: info("comments")?.exhausted ?? null,
      file: m.commentsFile || null,
    },
    warnings: m.warnings || [],
    readingGuide: m.readingGuide || null,
    packet: packetPath(packet.bvid),
    next: packet.workflow?.next || null,
  };
}

/**
 * 准备一条视频的证据包（字幕/ASR/评论/弹幕/拼图）。
 * 默认行为与 `node cli/note.mjs prepare <BV>` 一致。
 */
export async function prepareVideo({
  bvid,
  commentsOnly = false,
  comments = commentsOnly ? 150 : 5,
  commentsMode = "all",
  maxCommentPages = 80,
  danmaku = null,
  asr = false,
  forceAsr = false,
  refresh = false,
  offline = false,
  depth = "auto",
  asrModel = null,
  maxAsrMinutes = 60,
  credPath,
  onLog = () => {},
} = {}) {
  ensureDirs();
  const id = extractBv(bvid);
  const api = offline ? null : await openApi({ credPath });
  const favs = await readJson(FILES.favs, null);
  const packet = await buildPacket(api, id, {
    favs,
    asr,
    forceAsr,
    refresh,
    offline,
    depth,
    commentsOnly,
    comments,
    commentsMode,
    maxCommentPages,
    danmaku: danmaku === null ? !commentsOnly : danmaku,
    asrModel,
    maxAsrMinutes,
    onDownloadProgress: null,
    log: onLog,
  });
  await touchState(id, { status: "packed", title: packet.view?.title });
  return summarizePacket(packet);
}

/** Read only evidence files generated for this BV, never a path supplied by a tool caller. */
export async function readEvidence({ bvid, kind, offset = 0, limit = 4000 }) {
  const id = extractBv(bvid);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new UserInputError("offset 必须是非负整数");
  if (!Number.isInteger(limit) || limit < 2 || limit > 8000) throw new UserInputError("limit 必须是 2–8000");

  try {
    const dir = join(await realpath(CACHE), id);
    const evidenceFile = async (name) => {
      const expected = join(dir, name);
      if (await realpath(expected) !== expected) throw new UserInputError("证据文件路径超出该视频的缓存范围");
      return expected;
    };
    const packet = await readJson(await evidenceFile("packet.json"));
    if (packet?.bvid !== id) throw new UserInputError("证据包与 BV 号不匹配，请重新运行 bili_read");
    const files = {
      guide: packet.materials?.readingGuide && "READING.md",
      transcript: packet.materials?.transcript && (packet.materials.indexedTranscript ? "transcript.indexed.txt" : "transcript.txt"),
      description: packet.materials?.description && "description.txt",
      comments: packet.materials?.commentsFile && "comments.md",
    };
    if (!Object.hasOwn(files, kind)) throw new UserInputError("不支持的证据类型");
    if (!files[kind]) throw new UserInputError(`该视频的证据包没有 ${kind} 材料，请查看 bili_read 的摘要`);

    const file = await open(await evidenceFile(files[kind]), "r");
    let text;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new UserInputError("证据文件不是普通文件或超过 8 MiB");
      text = await file.readFile("utf8");
    } finally {
      await file.close();
    }
    const isLowSurrogate = (index) => /[\uDC00-\uDFFF]/.test(text.charAt(index));
    if (offset > text.length || isLowSurrogate(offset)) throw new UserInputError("offset 无效，请使用上一页的 nextOffset");
    let end = Math.min(offset + limit, text.length);
    if (isLowSurrogate(end)) end--;
    return { bvid: id, kind, text: text.slice(offset, end), offset, nextOffset: end < text.length ? end : null, totalChars: text.length };
  } catch (error) {
    if (error.code === "ENOENT") throw new UserInputError("找不到对应的证据文件，请先运行 bili_read 生成证据包");
    throw error;
  }
}

/** 把正文写进 vault（含评论依据自证、时间戳审计、字数上限）。 */
export async function writeNoteFromBody({
  bvid,
  body,
  tags = [],
  rating = null,
  basis = "transcript",
  kind = "summary",
  allowLong = false,
  depth = "auto",
  onWarn = () => {},
} = {}) {
  const id = extractBv(bvid);
  if (!body || !String(body).trim()) throw new UserInputError("正文是空的");
  const packet = await readJson(packetPath(id), null);
  if (!packet) throw new UserInputError(`没有素材包 ${packetPath(id)}，先 prepare/pack`);
  if (packet.materials?.transcriptSha256 && (await transcriptDocument(packet)).sha256 !== packet.materials.transcriptSha256) {
    throw new Error("文字素材已变动，先 prepare/outline 更新阅读依据，再写入笔记");
  }
  if (!["transcript", "comments_only", "mixed"].includes(basis)) throw new Error("basis 必须是 transcript / comments_only / mixed");
  if (!["summary", "visual_only", "advertisement", "invalid"].includes(kind)) throw new Error("无效 note kind");
  if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) throw new Error("rating 需为 1–5");

  const budget = noteBudget(packet.view?.duration, { depth: packet.writing?.depth || depth });
  const count = bodyChars(body);
  if (count > budget.maxChars && !allowLong) {
    throw new Error(`正文 ${count} 字超过上限 ${budget.maxChars}，超了 ${count - budget.maxChars} 字；请压缩，确需保留可用 allowLong`);
  }

  let finalBody = body;
  if (basis === "comments_only") {
    const n = packet.materials?.comments?.length || 0;
    if (!n) throw new Error("没有评论材料：先 prepare --comments-only --comments N，再写评论依据的笔记");
    if (!body.includes(COMMENTS_ONLY_MARK)) {
      finalBody = `${COMMENTS_ONLY_MARK}\n> 以下内容全部来自 B 站评论区（共 ${n} 条）的观众说法，未观看视频本体、未核对原片；不能当作视频内容或作者原话引用。\n\n${body.trim()}\n`;
    }
  }

  const audit = citationAudit(finalBody, packet.view?.duration, { kind });
  if (audit.errors.length) throw new Error(audit.errors.join("；"));
  const warnings = audit.warnings.filter((w) => !(basis === "comments_only" && /时间戳|时间锚/.test(w)));
  for (const w of warnings) onWarn(w);
  if (basis === "comments_only" && audit.values.length) {
    const note = `以评论区为依据却出现了 ${audit.values.length} 个时间戳引用，确认它们不是编的`;
    warnings.push(note);
    onWarn(note);
  }

  const res = await writeNote({
    packet,
    body: finalBody,
    tags,
    rating,
    summaryDepth: budget.depth,
    noteKind: kind,
    evidenceBasis: basis,
    watched: basis !== "comments_only",
    budgetOverride: allowLong,
    assets: packet.materials?.sheets || [],
  });
  await touchState(id, { status: "written", title: packet.view?.title, note: res.relPath });
  return { relPath: res.relPath, absPath: res.absPath, warnings: [...(res.warnings || []), ...warnings] };
}

/** 笔记质检：结构 / 时间戳越界 / 图片链接 / 长度。返回结构化结果。 */
export async function verifyNote({ bvid } = {}) {
  const id = extractBv(bvid);
  const notes = await loadNotes();
  const meta = notes[id];
  if (!meta) throw new UserInputError(`没有 ${id} 的笔记记录`);
  const file = join(VAULT, meta.path);
  if (!existsSync(file)) throw new UserInputError(`笔记文件不存在：${meta.path}`);
  const text = await readFile(file, "utf8");
  const packet = await readJson(packetPath(id), null);
  const duration = packet?.view?.duration || meta.duration || 0;

  const errors = [];
  const warnings = [];

  if (!/^---\r?\n[\s\S]*?\r?\n---/.test(text)) errors.push("缺 frontmatter");
  if (!new RegExp(`bvid:\\s*${id}`).test(text)) errors.push("frontmatter 缺 bvid");

  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
    .split(/(?:\r?\n---\s*)?\r?\n## 原始素材\s*\r?\n/)[0];
  const field = (name) => text.match(new RegExp("^" + name + ":\\s*([^\\r\\n]+)", "m"))?.[1]?.replace(/^"|"$/g, "");
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
  const { maxChars } = noteBudget(duration, { depth });
  if ((field("note_kind") || "summary") === "summary" && chars < (depth === "shallow" ? 80 : 200)) {
    warnings.push(`正文偏短（${chars} 字），不要为凑数注水`);
  }
  if (chars > maxChars) warnings.push(`正文偏长（${chars} 字），该片长上限 ${maxChars}`);

  const links = [...text.matchAll(/!\[\[([^\]]+)\]\]/g)].map((x) => x[1]);
  for (const link of links) {
    const abs = join(VAULT, link.replace(/\//g, "\\"));
    if (!existsSync(abs)) errors.push(`图片链接失效：${link}`);
  }

  return {
    bvid: id,
    path: meta.path,
    ok: !errors.length,
    errors,
    warnings,
    timestamps: { count, max: maxTs, duration, maxClock: fmtClock(maxTs), durationClock: fmtClock(duration) },
    chars,
    images: links.length,
  };
}

/** 重建 vault/00-索引（收藏夹总表 + 标签表）。 */
export async function rebuildIndexes() {
  const favs = await readJson(FILES.favs, null);
  if (!favs) throw new UserInputError("没有 data/favs.json，先 fetch");
  return rebuildIndex({ favs });
}

// ---------------------------------------------------------------- 搜索

/**
 * UP 空间内搜索：带 keyword 时按服务端过滤翻 2 页（最多 100 条）；
 * keyword 没命中时退回"空间最新"，避免一个过滤词把整路召回打死。
 */
async function collectSpace(api, mid, keyword, { pages = 2 } = {}) {
  const out = [];
  for (let pn = 1; pn <= pages; pn++) {
    const page = await searchSpace(api, mid, keyword, { pn });
    out.push(...page);
    if (page.length < 50) break;
  }
  if (!out.length && keyword) return searchSpace(api, mid, "", { pn: 1 });
  return out;
}

/**
 * 找视频：本地收藏先验 + 站内多路召回 + 可解释重排。
 * 中文只加权，引号短语与 ≥3 字符英文/型号才是硬约束；找不到时给"最接近的缺什么"。
 */
export async function findVideos({
  query,
  top = 5,
  pages = 1,
  orders = ["totalrank", "pubdate"],
  up = null,
  duration = null,
  since = null,
  related = null,
  local = true,
  space = true,
  refresh = false,
  credPath,
} = {}) {
  const rawQuery = String(query || "").trim();
  if (!rawQuery) throw new UserInputError("查询不能为空");
  ensureDirs();
  const parsed = parseQuery(rawQuery);
  if (duration) {
    const [a, b] = String(duration).split(/[-–~]/);
    parsed.duration = { min: Number(a) || 0, max: b ? Number(b) : null };
  }
  if (since) {
    const t = Date.parse(String(since));
    if (!Number.isFinite(t)) throw new UserInputError(`since 解析失败：${since}`);
    parsed.since = t;
  }
  if (up) parsed.up = String(up);

  const notes = (await readJson(FILES.notes, {})) || {};
  const favs = local ? await readJson(FILES.favs, null) : null;
  const api = await openApi({ credPath });
  const topN = Math.max(1, Math.min(20, Number(top) || 5));
  const pageN = Math.max(1, Math.min(5, Number(pages) || 1));
  const cacheKey = digest(JSON.stringify({ q: rawQuery, orders, pages: pageN, up: parsed.up || null, related, local: Boolean(favs) })).slice(0, 16);
  const cache = searchCache(join(CACHE, "_search"), { ttl: 6 * 3600_000 });
  const t0 = Date.now();
  const value = await cache.get(cacheKey, async () => {
    const locals = favs ? localRecall({ favs, notes }, parsed) : [];
    const site = [];
    for (const order of orders) {
      for (let page = 1; page <= pageN; page++) {
        const r = await searchVideos(api, parsed.keyword, { order, page });
        site.push(...r.items);
        if (r.items.length < 20) break;
      }
    }
    const spaceItems = [];
    if (parsed.up && space) {
      const users = await searchUsers(api, parsed.up);
      if (users[0]) {
        // 服务端 keyword 过滤 + 翻页：旧实现传空串，只能看到 UP 最新 50 条
        // （影视飓风 938 个视频时覆盖率只有 5.3%）。
        const kw = parsed.keyword && parsed.keyword !== parsed.up ? parsed.keyword : "";
        const hits = await collectSpace(api, users[0].mid, kw);
        for (const it of hits) it.author = users[0].name;
        spaceItems.push(...hits);
      }
    }
    const relatedItems = related ? await relatedVideos(api, related) : [];
    return { local: locals, site, space: spaceItems, related: relatedItems };
  }, { refresh });

  const all = dedupe([...value.local, ...value.space, ...value.site, ...value.related]);
  const ranked = rankItems(all, parsed, { top: topN, nearMiss: 3 });
  return {
    query: rawQuery,
    parsed: {
      keyword: parsed.keyword,
      must: parsed.must,
      duration: parsed.duration,
      since: parsed.since ? new Date(parsed.since).toISOString().slice(0, 10) : null,
      up: parsed.up,
      ascii: parsed.ascii,
    },
    recall: {
      local: value.local.length,
      space: value.space.length,
      site: value.site.length,
      related: value.related.length,
      unique: all.length,
      cachedAt: value.cachedAt ?? null,
    },
    stats: ranked.stats,
    requests: api.calls,
    elapsedMs: Date.now() - t0,
    hits: ranked.hits.map((h) => ({
      bvid: h.item.bvid,
      title: h.item.title,
      author: h.item.author,
      minutes: Math.round((h.item.durationSec || 0) / 60),
      pubdate: h.item.pubdate ? new Date(h.item.pubdate).toISOString().slice(0, 10) : null,
      favorites: h.item.favorites,
      routes: h.item.routes,
      url: h.item.url,
      note: h.item.notePath || null,
      score: h.score,
      reasons: h.reasons,
    })),
    nearMiss: ranked.nearMiss.map((n) => ({
      bvid: n.item.bvid,
      title: n.item.title,
      author: n.item.author,
      missing: n.missing,
      score: n.score,
    })),
  };
}

// ---------------------------------------------------------------- 发现（刷B站）

/**
 * 替我刷 B 站：个性化推荐流 / 热门 / 排行榜 / 主题最新 四路取候选，排掉已收藏，再按收藏口味排序。
 * 与 findVideos 的分工：findVideos 是"找已知的那条"，feedVideos 是"我不知道看什么"。
 */
export async function feedVideos({
  topic = null,
  rcmd = 2,
  hot = 1,
  rank = null,
  days = 0,
  minMinutes = 0,
  maxMinutes = 0,
  top = 10,
  includeFaved = false,
  minInterest = null,
  refresh = false,
  credPath,
} = {}) {
  ensureDirs();
  const favs = await readJson(FILES.favs, null);
  const faved = new Set((favs?.videos || []).map((v) => v.bvid).filter(Boolean));
  const api = await openApi({ credPath });

  const rid = rank == null
    ? null
    : (typeof rank === "string" ? (REGIONS[rank] ?? (Number(rank) || 0)) : (Number(rank) || 0));
  const hotPages = Math.max(0, Math.min(3, Number(hot) || 0));
  const rcmdPages = Math.max(0, Math.min(5, Number(rcmd) || 0));
  const cacheKey = digest(JSON.stringify({ hotPages, rcmdPages, rid, topic })).slice(0, 16);
  const cache = searchCache(join(CACHE, "_feed"), { ttl: 30 * 60_000 });
  const raw = await cache.get(cacheKey, async () => {
    const out = { rcmd: [], hot: [], rank: [], topic: [] };
    for (let pn = 1; pn <= rcmdPages; pn++) out.rcmd.push(...(await rcmdFeed(api, { freshIdx: pn })));
    for (let pn = 1; pn <= hotPages; pn++) out.hot.push(...(await hotFeed(api, { pn })));
    if (rid != null) out.rank.push(...(await rankFeed(api, { rid })));
    if (topic) {
      for (let pn = 1; pn <= 2; pn++) {
        const page = await topicFeed(api, topic, { page: pn });
        out.topic.push(...page);
        if (page.length < 20) break;
      }
    }
    return out;
  }, { refresh });

  const model = buildInterestModel(favs || { videos: [] });
  const all = dedupe([...raw.rcmd, ...raw.hot, ...raw.rank, ...raw.topic]);
  const minSec = minMinutes ? minMinutes * 60 : 0;
  const maxSec = maxMinutes ? maxMinutes * 60 : Infinity;
  const counts = { sources: all.length, rcmd: raw.rcmd.length, faved: 0, duration: 0, stale: 0, lowInterest: 0 };
  const pool = [];
  for (const it of all) {
    if (!includeFaved && faved.has(it.bvid)) { counts.faved++; continue; }
    if (it.durationSec && (it.durationSec < minSec || it.durationSec > maxSec)) { counts.duration++; continue; }
    if (days && it.pubdate && Date.now() - it.pubdate > days * 86400_000) { counts.stale++; continue; }
    pool.push(it);
  }

  // 没有收藏数据 / 主题明确时不做兴趣门槛，避免一条都刷不出来
  const floor = minInterest != null ? Number(minInterest) : (model.sample ? (topic ? 0 : 1) : 0);
  const corpusDf = buildCorpusDf(pool);
  const scored = pool
    .map((it) => {
      const trusted = it.routes?.some((r) => r.startsWith("推荐流"));
      // B 站自己的推荐流已经算过口味，给它一点加成，并且不拿我们的兴趣门槛再筛一遍
      return { ...scoreFeedItem(it, model, { days, corpusDf, boost: trusted ? 0.8 : 0 }), trusted };
    })
    .filter((s) => s.trusted || s.interest >= floor)
    .sort((a, b) => b.score - a.score);
  counts.lowInterest = pool.length - scored.length;

  // 推荐流 : 其它 = 2:1 交替出。纯按分数排会被热门大流量挤掉推荐流，
  // 全给推荐流又太窄（看不到热门里的好东西）。
  const limit = Math.max(1, Math.min(50, Number(top) || 10));
  const trustedList = scored.filter((s) => s.trusted);
  const restList = scored.filter((s) => !s.trusted);
  const picked = [];
  let ti = 0, ri = 0;
  while (picked.length < limit && (ti < trustedList.length || ri < restList.length)) {
    for (let k = 0; k < 2 && ti < trustedList.length && picked.length < limit; k++) picked.push(trustedList[ti++]);
    if (ri < restList.length && picked.length < limit) picked.push(restList[ri++]);
  }

  return {
    filter: { topic, rcmd: rcmdPages, hot: hotPages, rank: rid, days, minMinutes, maxMinutes, includeFaved, minInterest: floor },
    model: { sample: model.sample, grams: model.weights.size },
    recall: counts,
    items: picked.map((s) => ({
      bvid: s.item.bvid,
      title: s.item.title,
      author: s.item.author,
      minutes: Math.round((s.item.durationSec || 0) / 60),
      pubdate: s.item.pubdate ? new Date(s.item.pubdate).toISOString().slice(0, 10) : null,
      views: s.item.play,
      favorites: s.item.favorites,
      routes: s.item.routes,
      url: s.item.url,
      score: s.score,
      interest: s.interest,
      reasons: s.reasons,
    })),
  };
}
