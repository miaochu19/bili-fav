import { buildMaterialPacket } from "./packet-build.mjs";
import { assessSubtitle, stopOnAccountError } from "./subtitle-quality.mjs";
import { mkdir, readdir, stat, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { CACHE, FILES } from "./paths.mjs";
import { readJson, writeJsonAtomic, writeTextAtomic } from "./fsx.mjs";
import { getView, getPages, firstPartView, getPlayer, fetchSubtitle, getDanmakuPeaks, ensureAudioFile, fmtClock } from "./media.mjs";
import { extractAudio, probeAudio, writeSheetIndex } from "./frames.mjs";
import { transcribe } from "./asr.mjs";
import { parseTranscript, filterSuspectSegments, alignSheets, transcriptClock } from "./transcript.mjs";
import { noteBudget, sheetBudget } from "./quality.mjs";

export function packetPath(bv) {
  return join(CACHE, bv, "packet.json");
}

/** 从标题里取可检索的片段：英文/数字词 + 中文 3–4 字 n-gram。 */
export function titleTokens(title) {
  const s = String(title || "");
  const tokens = new Set();
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9._-]{1,}/g)) tokens.add(m[0].toLowerCase());
  for (const m of s.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const seg = m[0];
    for (let n = 3; n <= Math.min(4, seg.length); n++) {
      for (let i = 0; i + n <= seg.length; i++) tokens.add(seg.slice(i, i + n));
    }
  }
  return [...tokens].slice(0, 40);
}

/**
 * 区分性片段：标题里真正能证明"这是同一条视频"的词。
 * - ASCII 词（AI / DSH / X500 / GPT6）：最有区分度，长度 ≥2、不以数字开头；
 * - 中文 4-gram；标题里的中文段都不足 4 字时退回 3-gram。
 * 不用 2-gram：像"什么/怎么"这种口水词会在任何中文文本里命中，把错轨洗白。
 */
export function distinctiveTokens(title) {
  const s = String(title || "");
  const ascii = new Set();
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9._+-]*[A-Za-z0-9]/g)) {
    const w = m[0].toLowerCase();
    if (w.length >= 2 && !/^\d+$/.test(w)) ascii.add(w);
  }
  const cjk = new Set();
  const segments = [...s.matchAll(/[\u4e00-\u9fa5]{3,}/g)].map((m) => m[0]);
  const longest = Math.max(0, ...segments.map((x) => x.length));
  const n = longest >= 4 ? 4 : 3;
  for (const seg of segments) {
    for (let i = 0; i + n <= seg.length; i++) cjk.add(seg.slice(i, i + n));
  }
  return { ascii: [...ascii].slice(0, 20), cjk: [...cjk].slice(0, 40) };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** ASCII 词要按词边界匹配：`ai` 不能命中 `said`/`again`/`detail`。 */
function asciiHit(token, lowerText) {
  return new RegExp(`(^|[^a-z0-9])${escapeRe(token)}($|[^a-z0-9])`).test(lowerText);
}

/**
 * 字幕"错轨"检测：B 站偶发把别的视频的 AI 字幕挂到这条视频上。
 *
 * 判据分两层：
 * 1. 标题片段**一个都没命中** → 可疑；
 * 2. 命中率很低 **且** 语速离群（>9 或 <1.5 字/秒）→ 可疑。
 *    标题里的英文名可能没有出现在正常字幕中，因此同时检查中文词和语速。
 */
export function subtitleMismatch(title, text, { charsPerSec = null } = {}) {
  const { ascii, cjk } = distinctiveTokens(title);
  if (!text || (!ascii.length && !cjk.length)) return { checked: false };
  const lower = String(text).toLowerCase();
  const asciiHits = ascii.filter((t) => asciiHit(t, lower));
  const cjkHits = cjk.filter((t) => lower.includes(t));
  const total = ascii.length + cjk.length;
  const hits = asciiHits.length + cjkHits.length;
  const ratio = hits / total;
  const asciiMiss = ascii.length > 0 && asciiHits.length === 0;
  const cjkMiss = ascii.length === 0 && cjk.length > 0 && cjkHits.length === 0;
  const miss = hits === 0;
  const rateOdd = charsPerSec != null && (charsPerSec > 9 || charsPerSec < 1.5);
  const suspicious = miss || (rateOdd && ratio < 0.2);
  return {
    checked: true,
    hits,
    total,
    ratio: +ratio.toFixed(2),
    ascii: { hits: asciiHits.length, total: ascii.length, sample: ascii.slice(0, 4) },
    cjk: { hits: cjkHits.length, total: cjk.length },
    charsPerSec,
    suspicious,
    reason: miss ? (ascii.length > 0 ? "ascii-miss" : "cjk-miss") : suspicious ? "rate-outlier" : null,
  };
}

/** 只取字幕文件里的正文行（"[" 开头的带时间戳行）。 */
function bodyLines(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((l) => /^\[/.test(l))
    .join("\n");
}

/**
 * 取官方字幕，带"重新要一次"的重试。
 * 同一视频多次查询可能得到内容不同的 AI 字幕。按标题匹配度打分，
 * 最多试 3 轮，留下最像的那份；全都不像就返回匹配度最高的（后续交给 ASR 兜底）。
 */
export async function resolveSubtitle(api, bvid, cid, view, { attempts = 2, log = () => {},
  loadPlayer = () => getPlayer(api, bvid, cid), loadSubtitle = (candidate) => fetchSubtitle(api, candidate.url) } = {}) {
  const rank = (s) => /^zh-CN$/i.test(s.lan) ? 0 : /^zh-Hans$/i.test(s.lan) ? 1 : /^ai-zh$/i.test(s.lan) ? 2 : /zh/i.test(s.lan) ? 3 : 4;
  const minLines = Math.max(3, Math.floor((view.duration || 0) / 120));
  let best = null;
  for (let round = 0; round < attempts; round++) {
    let player;
    try { player = await loadPlayer(round > 0); }
    catch (err) { stopOnAccountError(err); log(`播放器信息未取得：${err.message}`); continue; }
    const candidates = (player.subtitles || []).slice().sort((a, b) => rank(a) - rank(b)).slice(0, 2);
    if (!candidates.length) return best; // No track is not a reason to request the same empty player three times.
    for (const candidate of candidates) {
      try {
        const lines = await loadSubtitle(candidate, round > 0);
        if (!lines.length) continue;
        const text = lines.map((l) => l.text).join("\n");
        const chars = lines.reduce((n, l) => n + String(l.text || "").length, 0);
        const check = subtitleMismatch(view.title, text, { charsPerSec: view.duration ? +(chars / view.duration).toFixed(2) : null });
        const descriptionHits = distinctiveTokens(view.desc).cjk.filter((t) => text.includes(t)).length;
        const assessment = assessSubtitle(lines, { duration: view.duration, lexical: check, descriptionHits, playerSource: player.source });
        const score = (assessment.level === "suspect" ? -100 : assessment.level === "review" ? 0 : 100) + Math.min(50, check.hits || 0);
        const result = { pick: candidate, lines, check, assessment, score };
        if (!best || score > best.score || score === best.score && lines.length > best.lines.length) best = result;
        // Lack of title words alone is a review task, not a forced expensive fallback.
        if (assessment.level !== "suspect" && player.source !== "legacy" && lines.length >= minLines) return result;
      } catch (err) { stopOnAccountError(err); log(`字幕轨 ${candidate.lan} 未取得：${err.message}`); }
    }
    if (round < attempts - 1) log("字幕缺失/结构异常或 legacy 来源，刷新一次播放器信息…");
  }
  return best;
}

/** 找到最近生成的一组拼图目录。 */
export async function findSheets(dir, { duration = Infinity, subtitles = [] } = {}) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const dirs = entries.filter((d) => d.isDirectory() && d.name.startsWith("sheets_"));
    let best = null;
    for (const d of dirs) {
      const p = join(dir, d.name);
      const manifestStat = await stat(join(p, "sheets.json")).catch(() => null);
      if (!manifestStat && !(await readdir(p)).some((f) => /^sheet_\d+\.jpg$/.test(f))) continue;
      const st = manifestStat || await stat(p).catch(() => null);
      if (st && (!best || st.mtimeMs > best.mtime)) best = { path: p, mtime: st.mtimeMs, name: d.name };
    }
    if (!best) return { dir: null, sheets: [] };
    const manifest = await readJson(join(best.path, "sheets.json"), null);
    if (manifest) {
      if (![1, 2].includes(manifest.version) || !Array.isArray(manifest.sheets)) throw new Error("不支持或损坏的 sheets.json 结构");
      for (const sheet of manifest.sheets) {
        if (!sheet || !/^sheet_\d+\.jpg$/.test(sheet.file) || !Number.isFinite(sheet.from) || !Number.isFinite(sheet.to) || sheet.to <= sheet.from)
          throw new Error("拼图文件名/时间窗无效");
        if (sheet.cells != null && !Array.isArray(sheet.cells)) throw new Error("拼图 cells 不是数组");
      }
      // manifest 存在就按它读，哪怕 sheets 是空的：空 manifest 也不能掉进"按文件名重建"，
      // 那条路假设 from=0、格子均匀，窗口补图（--from 60）会被错位成 0 开头。
      const sheets = alignSheets((manifest.sheets || [])
        .filter((s) => /^sheet_\d+\.jpg$/.test(s.file) && existsSync(join(best.path, s.file)))
        .map((s) => ({ ...s, file: join(best.path, s.file) })), subtitles);
      return {
        dir: best.path, sheets,
        degraded: manifest.degraded ?? null,
        medianShot: manifest.medianShot ?? null,
        from: manifest.from ?? 0,
        to: manifest.to ?? null,
        warnings: sheets.length < manifest.sheets.length ? ["部分拼图文件缺失，画面材料不完整"] : [],
      };
    }
    const files = (await readdir(best.path)).filter((f) => /^sheet_\d+\.jpg$/.test(f)).sort();
    const m = best.name.match(/^sheets_(\d+(?:\.\d+)?)s_(\d+)x\d+$/);
    if (!m) throw new Error("窗口/场景拼图缺少 manifest，不能从文件名猜测时间窗");
    const step = m ? Number(m[1]) : 5;
    const grid = m ? Number(m[2]) : 4;
    return {
      dir: best.path,
      sheets: alignSheets(files.map((f, i) => ({
        file: join(best.path, f),
        from: i * grid * grid * step,
        to: Math.min(duration, (i + 1) * grid * grid * step),
        cells: Array.from({ length: grid * grid }, (_, k) => {
          const from = (i * grid * grid + k) * step;
          return { index: k, row: Math.floor(k / grid) + 1, column: k % grid + 1, from, to: Math.min(duration, from + step), at: from };
        }).filter((c) => c.from < duration),
      })).filter((s) => s.from < duration), subtitles),
    };
  } catch (err) {
    return { dir: null, sheets: [], warnings: [`拼图索引未读取：${err.message}`] };
  }
}

/**
 * 为一个 BV 打包素材：字幕 / 本地转写 / 弹幕峰值 / 拼图 / 收藏夹归属。
 * 关键逻辑：字幕疑似错轨 → 重取一次 → 仍可疑且有 --asr 就本地转写。
 */
export function buildPacket(api, bvid, options = {}) {
  return buildMaterialPacket(api, bvid, { ...options, resolveSubtitle, findSheets });
}

/** 工作清单：按收藏时间倒序，排除已整理的。 */
export async function buildWorklist() {
  const favs = await readJson(FILES.favs, null);
  const notes = (await readJson(FILES.notes, {})) || {};
  if (!favs) return { favs: null, pending: [], done: [] };
  const all = (favs.videos || []).filter((v) => !v.invalid);
  const done = all.filter((v) => notes[v.bvid]);
  const pending = all
    .filter((v) => !notes[v.bvid])
    .sort((a, b) => (b.favTime || 0) - (a.favTime || 0));
  return { favs, pending, done };
}

export function estimateCost(video) {
  const duration = video.duration || 0;
  const minutes = Math.round(duration / 60);
  // 360p 约 0.5–1 MB/分钟，取 0.7
  const mb = Math.round(minutes * 0.7);
  // 与 video.mjs 的自适应抽帧一致：目标 20 张拼图，步长不小于 5 秒
  const maxSheets = sheetBudget(duration);
  const step = Math.min(120, Math.max(5, Math.ceil(duration / (maxSheets * 16))));
  const sheets = Math.min(maxSheets, Math.max(1, Math.ceil(duration / step / 16)));
  return { minutes, mb, sheets, maxSheets, step, imageUpperBound: maxSheets + 1 };
}
