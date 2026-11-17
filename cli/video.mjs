#!/usr/bin/env node
// 单条视频内容层 CLI：probe / sub / danmaku / comments / audio / frames / sheet
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CACHE, ensureDirs, rel } from "../lib/paths.mjs";
import { loadCookies } from "../lib/cookies.mjs";
import { BiliApi, BiliError } from "../lib/api.mjs";
import {
  getView, getPages, firstPartView, getPlayer, fetchSubtitle, getDanmakuPeaks, getComments,
  ensureVideoFile, ensureAudioFile, fmtBytes, fmtClock,
} from "../lib/media.mjs";
import { buildSheets, buildSubStrip, grabFrame, extractAudio, FFMPEG } from "../lib/frames.mjs";
import { transcribe } from "../lib/asr.mjs";
import { analyzeAudioActivity } from "../lib/loudness.mjs";
import { assessAsrEvidence, describeAsrEvidence } from "../lib/asr-review.mjs";
import { readJson, writeJsonAtomic, writeTextAtomic } from "../lib/fsx.mjs";
import { readFile } from "node:fs/promises";
import { parseTranscript } from "../lib/transcript.mjs";
import { openMaterials } from "../lib/materials.mjs";
import { readDanmaku, renderDanmakuReading } from "../lib/danmaku.mjs";
import { sheetBudget } from "../lib/quality.mjs";
import { asrModelKey } from "../lib/asr.mjs";
import { saveTranscriptCache } from "../lib/material-cache.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0] || "help";
const rest = argv.slice(1);

/** 播放/收藏这类数按万显示，避免手算错一个数量级。 */
const wan = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "0";
  return v >= 10000 ? `${(v / 10000).toFixed(1)}万` : String(v);
};

/** 发布时间按本机时区显示（B 站页面也是本地时间，别再说 UTC）。 */
const localTime = (sec) => {
  const d = new Date(Number(sec) * 1000);
  if (!Number.isFinite(d.getTime())) return "未知";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function flag(name, fallback) {
  const i = rest.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = rest[i + 1];
  return next && !next.startsWith("--") ? next : true;
}
const has = (n) => rest.includes(`--${n}`);

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c("2"), bold = c("1"), green = c("32"), yellow = c("33"), red = c("31");

function extractBv(input) {
  const s = String(input || "");
  const m = s.match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : s;
}

async function openApi() {
  const { cookies } = await loadCookies({ credPath: flag("cred") });
  const api = new BiliApi({ cookies, log: (m) => console.log(dim(m)) });
  await api.init();
  return { api, cookies };
}

async function resolveVideo(api, bvid) {
  return openMaterials(api, bvid, { refresh: has("refresh") });
}

function cacheDir(bv) {
  return join(CACHE, bv);
}

// ---------------------------------------------------------------- probe
async function probe() {
  const bvid = extractBv(rest[0]);
  if (!bvid) return usage();
  const { api } = await openApi();
  const context = await resolveVideo(api, bvid);
  const { view, pages, cid } = context;

  const player = await context.player().catch(() => ({ subtitles: [] }));
  let dan = { total: 0, peaks: [] };
  if (!has("light")) try { dan = await context.danmaku(); } catch { /* 忽略 */ }
  let comments = { list: [], total: 0 };
  if (!has("light")) try { comments = await context.comments(); } catch { /* 忽略 */ }

  console.log(`\n${bold(view.title)}`);
  console.log(`  ${dim("BV")} ${bvid}   ${dim("aid")} ${view.aid}   ${dim("cid")} ${cid}`);
  const category = [view.tname, view.tname_v2].filter(Boolean).join(" / ") || (view.tid ? `tid=${view.tid}（接口未返回名称）` : "接口未提供");
  console.log(`  ${dim("UP")} ${view.owner?.name} (${view.owner?.mid})${view.fans != null ? `　${dim("粉丝")} ${wan(view.fans)}` : ""}   ${dim("分区")} ${category}`);
  console.log(`  ${dim("时长")} ${fmtClock(view.duration)}   ${dim("发布")} ${localTime(view.pubdate)}`);
  console.log(`  ${dim("播放")} ${wan(view.stat?.view)}   ${dim("点赞")} ${wan(view.stat?.like)}   ${dim("收藏")} ${wan(view.stat?.favorite)}   ${dim("投币")} ${wan(view.stat?.coin)}   ${dim("弹幕")} ${wan(view.stat?.danmaku)}`);
  if (view.argue) console.log(`  ${dim("标注")} ${yellow(view.argue)}`);
  console.log(`  ${dim("字幕")} ${player.subtitles.length ? player.subtitles.map((s) => `${s.lanDoc}${s.ai ? "(AI)" : ""}`).join(", ") : "无（或需登录）"}`);
  console.log(`  ${dim("弹幕峰值")} ${dan.total} 条 / ${dan.peaks.length} 个 30s 桶`);
  if (pages.length > 1) console.log(`  ${dim("分P")} ${pages.length} 个：${pages.slice(0, 5).map((p) => p.part).join(" / ")}`);
  const desc = (view.desc || "").replace(/\s+/g, " ").slice(0, 200);
  if (desc) console.log(`  ${dim("简介")} ${desc}${(view.desc || "").length > 200 ? "…" : ""}`);

  const top = dan.peaks.slice().sort((a, b) => b.n - a.n).slice(0, 5);
  if (top.length) {
    console.log(`\n  ${dim("弹幕最密的时间点")}`);
    for (const p of top) console.log(`    ${fmtClock(p.sec).padStart(7)}  ${String(p.n).padStart(5)} 条`);
  }
  if (comments.list?.length) {
    console.log(`\n  ${dim(`热评（共 ≈${comments.total} 条）`)}`);
    for (const cm of comments.list.slice(0, 3)) {
      const tag = cm.tag ? `【${cm.tag}】` : "";
      console.log(`    ${tag}[${cm.like}] ${cm.name}：${String(cm.text).slice(0, 80)}${cm.replies ? `  └${cm.replies}` : ""}`);
    }
  }
  console.log();
}

// ---------------------------------------------------------------- sub
async function sub() {
  const bvid = extractBv(rest[0]);
  if (!bvid) return usage();
  const { api } = await openApi();
  const { view, cid } = await resolveVideo(api, bvid);
  const player = await getPlayer(api, bvid, cid);
  if (!player.subtitles.length) {
    console.log(yellow("没有字幕轨（匿名通常只能拿到 UP 上传的；AI 字幕需要登录 Cookie）。"));
    return;
  }
  const want = flag("lang");
  const pick = want
    ? player.subtitles.find((s) => s.lan.includes(want))
    : player.subtitles.find((s) => /zh/i.test(s.lan)) || player.subtitles[0];
  if (!pick) {
    console.log(red(`没找到语言 ${want}，可用：${player.subtitles.map((s) => s.lan).join(", ")}`));
    return;
  }
  const lines = await fetchSubtitle(api, pick.url);
  const text = lines.map((l) => `[${fmtClock(l.from)}-${fmtClock(l.to)}] ${l.text}`).join("\n");
  const out = flag("out");
  if (typeof out === "string") {
    await writeTextAtomic(out, `${view.title}\n${bvid}\n\n${text}\n`);
    console.log(green(`✓ 写入 ${out}（${lines.length} 行，${text.length} 字）`));
  } else {
    console.log(text);
  }
}

// ---------------------------------------------------------------- danmaku
const numberFlag = (name, fallback) => {
  const raw = flag(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${name} 需要数字，收到 ${raw}`);
  return n;
};

async function danmaku() {
  const bvid = extractBv(rest[0]);
  if (!bvid) return usage();
  const readMode = has("read") || ["from", "to", "query", "limit", "max-chars"].some((n) => flag(n) !== undefined);
  const { api } = await openApi();
  const context = await resolveVideo(api, bvid);
  const { view, cid } = context;

  if (!readMode) {
    const dan = await getDanmakuPeaks(api, cid, { bucketSec: Number(flag("bucket", 30)) });
    console.log(`弹幕 ${dan.total} 条，桶 ${dan.bucketSec}s，共 ${dan.peaks.length} 桶`);
    const top = dan.peaks.slice().sort((a, b) => b.n - a.n).slice(0, 20).sort((a, b) => a.sec - b.sec);
    for (const p of top) console.log(`  ${fmtClock(p.sec).padStart(8)}  ${String(p.n).padStart(5)}`);
    console.log(dim(`  读正文：node cli/video.mjs danmaku ${bvid} --read [--from 180 --to 210] [--query 关键词]`));
    return;
  }

  const value = await context.danmakuText();
  if (!value?.text) {
    throw new Error(value?.textError
      ? `弹幕正文解析失败：${value.textError}（峰值统计仍可用，不带 --read 即可）`
      : "这次没有取到弹幕正文");
  }
  const parsed = value.text;
  const selection = readDanmaku(parsed, {
    from: numberFlag("from", 0),
    to: numberFlag("to", view.duration + 1),
    query: String(flag("query", "")),
    limit: numberFlag("limit", 24),
    maxChars: numberFlag("max-chars", 4000),
  });
  const snapshot = await context.peekDanmakuText();
  const fetchedAt = Number.isFinite(snapshot?.at) ? new Date(snapshot.at).toISOString() : null;

  if (has("json")) {
    console.log(JSON.stringify({
      bvid, cid, title: view.title, duration: view.duration, fetchedAt,
      rawCount: parsed.rawCount, usableCount: parsed.usableCount, discarded: parsed.discarded,
      status: parsed.status, xmlSha256: value.xmlSha256 || null, ...selection,
    }, null, 2));
    return;
  }

  const text = renderDanmakuReading({ bvid, title: view.title, cid, duration: view.duration, fetchedAt,
    snapshot: value.xmlSha256 || null }, parsed, selection);
  console.log(text);
  if (typeof flag("out") === "string") {
    const out = join(CACHE, bvid, `danmaku-read-${Math.round(selection.from)}-${Math.round(selection.to)}.md`);
    await writeTextAtomic(out, `${text}\n`);
    console.log(green(`✓ 写入 ${rel(out)}`));
  }
}

// ---------------------------------------------------------------- comments
// 单页看楼（--pn）或翻页看完整评论区（--want / --all）。两条路都按
// "置顶 → UP 发言 → 点赞降序"排，UP 的楼中楼回复也会标出来。
async function comments() {
  const bvid = extractBv(rest[0]);
  if (!bvid) return usage();
  const { api } = await openApi();
  const context = await resolveVideo(api, bvid);
  const { view } = context;
  const ps = Math.min(20, Math.max(1, Number(flag("ps", flag("n", 20))) || 20));
  const pn = Math.max(1, Number(flag("pn", 1)) || 1);
  const maxChars = Math.max(40, Number(flag("max-chars", 400)) || 400);
  const wantFlag = flag("want", has("all") ? "all" : undefined);
  if (wantFlag === true) throw new Error("--want 后面要跟条数或 all");
  const want = wantFlag === undefined ? 0
    : /^(all|-1|\*)$/i.test(String(wantFlag)) ? Infinity : Number(wantFlag);
  // want=0 表示"只看这一页"（--pn）；大于 0 才走翻页。
  if (!(want === Infinity || Number.isInteger(want) && want >= 0)) throw new Error("--want 必须是正整数或 all");
  const mode = String(flag("sort", has("all") ? "all" : "hot"));
  if (!["hot", "time", "all"].includes(mode)) throw new Error("--sort 必须是 hot / time / all（all = 先热度、不够再按时间补齐）");
  const maxPages = Number(flag("max-pages", 80));
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 200) throw new Error("--max-pages 必须是 1–200");

  const deep = want > 0;
  const res = deep
    ? await context.comments(want, { mode, maxPages, maxChars, log: (m) => console.log(dim(`  · ${m}`)) })
    : await getComments(api, view.aid, { ps, pn, maxChars, upMid: view.owner?.mid,
      sort: mode === "time" ? "time" : "hot" });
  const list = res.list || [];

  if (rest.includes("--json")) {
    console.log(JSON.stringify({ bvid, aid: view.aid, title: view.title, ...res }, null, 2));
    return;
  }

  // --replies N：把前 N 条有楼中楼的根评论展开到底（默认 2 页 = 40 条）。
  const replyDepth = Math.max(0, Number(flag("replies", 0)) || 0);
  const replyPages = Math.max(1, Number(flag("reply-pages", 2)) || 2);
  const replyMap = new Map();
  if (replyDepth) {
    for (const c of list.filter((x) => x.replies > 0).slice(0, replyDepth)) {
      try { replyMap.set(c.rpid, await context.replies(c.rpid, { maxPages: replyPages, maxChars })); }
      catch (err) { console.log(yellow(`  ${c.name} 的楼中楼未取得：${err.message}`)); }
    }
  }

  const cover = deep
    ? `${list.length} 条 / 接口约 ${res.total || 0} 条`
      + `${res.acount && res.acount !== res.total ? `（含楼中楼 ${res.acount} 条）` : ""} · `
      + `${mode === "time" ? "时间序" : mode === "hot" ? "热度序" : "置顶→UP→点赞"} · ${res.pages} 页 · `
      + `${res.exhausted ? "已翻到底" : res.truncated ? "预算用完未到底" : "未到底"}`
    : `第 ${pn} 页 ${list.length} 条 · ${mode === "time" ? "时间序" : "热度序"} · 接口约 ${res.total || 0} 条`;
  const lines = [];
  lines.push(`BV ${bvid}  aid ${view.aid}  ${cover}`);
  if (!list.length) lines.push("（这一页没有评论：可能关了评论区，或页码/翻页超了）");
  for (const [i, c] of list.entries()) {
    const marks = [c.tag ? `【${c.tag}】` : "", c.isUp ? "【UP】" : ""].filter(Boolean).join("");
    lines.push("", `[${i + 1}] ${marks}♥${c.like}  ${c.name}（mid ${c.mid}）  ${c.time}`, `    ${c.text}`);
    const full = replyMap.get(c.rpid);
    if (full) {
      for (const r of full.list) lines.push(`    ↳ ${r.isUp ? "【UP】" : ""}${r.name}（♥${r.like}）：${r.text}`);
      if (full.list.length < full.total) lines.push(`    └ 楼中楼共 ${full.total} 条，本次取 ${full.list.length} 条（--reply-pages 可加大）`);
    } else {
      for (const r of c.replyPreview || []) lines.push(`    ↳ ${r.isUp ? "【UP】" : ""}${r.name}：${r.text}`);
      if (c.replies) lines.push(`    └ 楼中楼 ${c.replies} 条（--replies N 展开）`);
    }
  }

  console.log(`\n${bold(view.title)}`);
  for (const line of lines) console.log(line);
  console.log();
  if (typeof flag("out") === "string") {
    const target = String(flag("out"));
    await writeTextAtomic(target, `# 评论（未核实）：${view.title}\n\n${lines.join("\n")}\n`);
    console.log(green(`✓ 写入 ${rel(target)}`));
  }
  if (rest.includes("--pics") || flag("pics") === true) {
    const withPics = list.filter((c) => c.pics?.length);
    if (!withPics.length) { console.log(dim("  本次评论没有配图")); return; }
    const dir = join(CACHE, bvid, "comments");
    await mkdir(dir, { recursive: true });
    for (const c of withPics) {
      for (const [i, p] of c.pics.entries()) {
        const ext = (p.url.split(".").pop() || "jpg").split("?")[0].slice(0, 4);
        const file = join(dir, `${c.rpid}-${i + 1}.${ext}`);
        try {
          const r = await fetch(p.url, {
            headers: { "User-Agent": "Mozilla/5.0", Referer: `https://www.bilibili.com/video/${bvid}/` },
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          await writeFile(file, Buffer.from(await r.arrayBuffer()));
          console.log(`  ${dim("图")} ${rel(file)}  ${p.w}×${p.h}  ← ${c.name}`);
        } catch (err) {
          console.log(yellow(`  ${c.name} 的图下载失败：${err.message}`));
        }
      }
    }
  }
}

// ---------------------------------------------------------------- audio
async function audio() {
  const bvid = extractBv(rest[0]);
  const { api } = await openApi();
  const { cid } = await resolveVideo(api, bvid);
  const { file } = await ensureAudioFile(api, bvid, cid);
  console.log(`\n${green("✓")} ${rel(file)}  ${fmtBytes((await import("node:fs")).statSync(file).size)}`);
}

// ---------------------------------------------------------------- asr
async function asr() {
  const bvid = extractBv(rest[0]);
  const { api } = await openApi();
  const { view, cid } = await resolveVideo(api, bvid);
  const t0 = Date.now();
  process.stdout.write(`  下载音频 …`);
  const { file: audioFile } = await ensureAudioFile(api, bvid, cid);
  process.stdout.write(`\r  抽 16k 单声道 …                    \n`);
  const wavAbs = join(cacheDir(bvid), "audio16k.wav");
  await extractAudio(audioFile, wavAbs, { duration: view.duration });
  const out = await transcribe(wavAbs, { bvid, model: flag("model"), threads: flag("threads"), duration: view.duration });
  const asrText = await readFile(out.transcript, "utf8");
  // 证伪：文本重复 + 音频活跃度（whisper.cpp 无 no_speech_prob，只能靠这两路）
  const activity = await analyzeAudioActivity(wavAbs).catch(() => null);
  const evidence = assessAsrEvidence({ segments: out.segments || parseTranscript(asrText), duration: view.duration, activity });
  await saveTranscriptCache(cacheDir(bvid), { bvid, cid, duration: view.duration }, { text: asrText, source: "asr",
    modelKey: await asrModelKey(flag("model")), language: "本地转写", discardedCount: out.discardedCount, asrEvidence: evidence });
  out.transcript = join(cacheDir(bvid), "transcript.txt");
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`${green("✓")} ${rel(out.transcript)}  ${out.lines} 段 · 用时 ${secs}s`);
  if (out.preview) console.log(dim(`  ${out.preview}`));
  console.log(dim(`  视频时长 ${fmtClock(view.duration)}`));
  const hint = describeAsrEvidence(evidence);
  if (hint) console.log(yellow ? yellow(`  ! ${hint}`) : `  ! ${hint}`);
}


// ---------------------------------------------------------------- frames / sheet
async function sheet() {
  const bvid = extractBv(rest[0]);
  const qn = Number(flag("qn", 16));
  const gridRaw = String(flag("grid", 4)), match = gridRaw.match(/^(\d+)(?:x(\d+))?$/);
  if (!match || (match[2] && match[1] !== match[2])) throw new Error("--grid 请使用 4 或 4x4 这样的正方形网格");
  const grid = Number(match[1]);
  const cell = Number(flag("cell", 384));

  const { api } = await openApi();
  const { view, cid } = await resolveVideo(api, bvid);

  // 没指定 --step 时按片长自适应：目标 12–24 张拼图，避免长视频生成上百张
  const explicit = flag("step", undefined);
  const from = Number(flag("from", 0)), to = Number(flag("to", view.duration));
  const targetSheets = Number(flag("max-sheets", sheetBudget(to - from)));
  const step = explicit !== undefined
    ? Number(explicit)
    : Math.min(120, Math.max(5, Math.ceil((to - from) / (targetSheets * grid * grid))));

  const { file } = await ensureVideoFile(api, bvid, cid, { qn });
  const mode = flag("mode", explicit !== undefined ? "uniform" : "scene");
  const outDir = join(cacheDir(bvid), `sheets_${step}s_${grid}x${grid}_${mode}_${from}-${to}`);
  console.log(`\n  抽帧中（每 ${step}s，${grid}×${grid}，${cell}px，片长 ${fmtClock(view.duration)}）…`);
  const transcript = await readFile(join(cacheDir(bvid), "transcript.txt"), "utf8").catch(() => "");
  const sheets = await buildSheets(file, outDir, { step, grid, cell, from, to, mode, maxSheets: targetSheets,
    subtitles: parseTranscript(transcript), log: console.log });
  if (!sheets.length) {
    console.log(red("没生成任何拼图，检查视频是否可解码"));
    return;
  }
  const packetFile = join(cacheDir(bvid), "packet.json");
  const packet = await readJson(packetFile, null);
  if (packet) {
    packet.materials.sheets = sheets;
    packet.materials.sheetsDir = outDir;
    const manifest = await readJson(join(outDir, "sheets.json"), null);
    packet.materials.sheetsDegraded = manifest?.degraded || null;
    packet.materials.sheetsMedianShot = manifest?.medianShot || null;
    // 生成拼图后同步降级标记：不刷新的话 packet 里还留着上一次 pack 的值
    packet.materials.sheetsDegraded = sheets.degraded ?? null;
    packet.materials.sheetsMedianShot = sheets.medianShot ?? null;
    await writeJsonAtomic(packetFile, packet);
  }
  console.log(`${green("✓")} ${sheets.length} 张拼图 → ${rel(outDir)}`);
  for (const s of sheets) console.log(`   ${rel(s.file)}  ${fmtClock(s.from)}–${fmtClock(s.to)}`);
  console.log(dim(`\n   读图顺序：先通读拼图看全片结构，再对可疑处用 grabFrame 回读单帧。`));
}

async function substrip() {
  const bvid = extractBv(rest[0]);
  if (!bvid) return usage();
  const { api } = await openApi();
  const { view, cid } = await resolveVideo(api, bvid);
  const { file } = await ensureVideoFile(api, bvid, cid);
  const out = join(cacheDir(bvid), "substrip.jpg");
  await buildSubStrip(file, out, { step: Number(flag("step", 3)), crop: Number(flag("crop", 0.18)),
    width: Number(flag("width", 960)), from: Number(flag("from", 0)), to: Number(flag("to", view.duration)), maxFrames: Number(flag("max-frames", 80)) });
  console.log(`${green("✓")} ${rel(out)}`);
}

// ---------------------------------------------------------------- 文本
async function text() {
  const bvid = extractBv(rest[0]);
  const { api } = await openApi();
  const { view, cid } = await resolveVideo(api, bvid);
  const player = await getPlayer(api, bvid, cid).catch(() => ({ subtitles: [] }));
  if (player.subtitles.length) {
    const lines = await fetchSubtitle(api, player.subtitles[0].url);
    console.log(`# ${view.title}\n\n${lines.map((l) => `[${fmtClock(l.from)}] ${l.text}`).join("\n")}`);
    return;
  }
  console.log(yellow(`无字幕轨。下一步可：`));
  console.log(`  1. 配 Cookie 后重试（AI 字幕需要登录）`);
  console.log(`  2. node cli/video.mjs audio ${bvid} → 本地 ASR`);
  console.log(`  3. node cli/video.mjs sheet ${bvid} → 读画面（硬字幕靠 OCR/看图）`);
}

// ---------------------------------------------------------------- grab
/** 回读某一秒的单帧，用来核对参数、型号、字幕。 */
async function grab() {
  const bvid = extractBv(rest[0]);
  const at = Number(flag("at", 0));
  const width = Number(flag("width", 1280));
  const { api } = await openApi();
  const { cid } = await resolveVideo(api, bvid);
  const { file } = await ensureVideoFile(api, bvid, cid, { qn: Number(flag("qn", 16)) });
  const out = join(cacheDir(bvid), `frame_${String(at).replace(/[^\d]/g, "")}.jpg`);
  await grabFrame(file, at, out, { width });
  console.log(`${green("✓")} ${rel(out)}  @ ${fmtClock(at)}`);
}

function usage() {
  console.log(`
${bold("bili-fav video")} —— 单条视频内容层

  node cli/video.mjs probe <BV>              元数据 + 字幕轨 + 弹幕峰值 + 热评
  node cli/video.mjs probe <BV> --light      选片用：只取可复用的元数据和字幕轨
  node cli/video.mjs text <BV>               字幕全文（没有就提示下一步）
  node cli/video.mjs sub <BV> [--out f]      字幕写入文件
  node cli/video.mjs danmaku <BV>            弹幕热区
  node cli/video.mjs danmaku <BV> --read [--from 180 --to 210] [--query 关键词]
                                            读弹幕正文：窗口/关键词回读，默认分散取 24 种文本、4000 字
                                            可加 --limit / --max-chars / --json / --out
  node cli/video.mjs comments <BV> [--sort hot|time] [--pn 1] [--ps 20] [--json]
                                            单页评论区（含置顶 / UP 置顶 / 楼中楼预览）
  node cli/video.mjs comments <BV> --want 150 --sort all
                                            翻页看完整评论区：置顶 → UP 发言 → 点赞降序
                                            --want N|all / --max-pages 80 / --replies N / --pics / --out f
  node cli/video.mjs audio <BV>              下载音频（给 ASR）
  node cli/video.mjs asr <BV> [--model small] 本地转写 → transcript.txt
  node cli/video.mjs sheet <BV> [--step 5]   4×4 接触印相纸（先下 360p）
  node cli/video.mjs frames <BV>             同 sheet
  node cli/video.mjs sheet <BV> --mode scene [--from 60 --to 120]  场景感知 + 逐格字幕
  node cli/video.mjs substrip <BV>           硬字幕底部拼接（--max-frames 80）
  node cli/video.mjs grab <BV> --at 125      回读第 125 秒的单帧
`);
}

async function main() {
  ensureDirs();
  switch (cmd) {
    case "probe": await probe(); break;
    case "text": await text(); break;
    case "sub": await sub(); break;
    case "danmaku": await danmaku(); break;
    case "comments": await comments(); break;
    case "audio": await audio(); break;
    case "asr": await asr(); break;
    case "sheet": case "frames": await sheet(); break;
    case "grab": await grab(); break;
    case "substrip": await substrip(); break;
    default: usage();
  }
}

main().catch((err) => {
  if (err instanceof BiliError) console.error(red(`\n${err.message}`));
  else console.error(red(`\n${err.stack || err.message}`));
  process.exitCode = 1;
});
