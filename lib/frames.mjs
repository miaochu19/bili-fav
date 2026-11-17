import { spawn } from "node:child_process";
import { openSync, closeSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, rm, rename, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { TOOLS, LOGS } from "./paths.mjs";
import { ensureDirs } from "./paths.mjs";
import { writeJsonAtomic, writeTextAtomic } from "./fsx.mjs";
import { alignSheets } from "./transcript.mjs";
import { fmtClock } from "./media.mjs";

export const FFMPEG = join(TOOLS, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
export const FFPROBE = join(TOOLS, process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
export const WHISPER = join(TOOLS, "whisper", "Release", process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
export const WHISPER_MODELS = join(TOOLS, "whisper", "models");

/**
 * 跑 ffmpeg/ffprobe。
 * 沙箱里 Node 的子进程管道会 EPERM，所以输出重定向到临时文件再读。
 */
export function run(bin, args, { timeoutMs = 30 * 60 * 1000, cwd, env } = {}) {
  ensureDirs();
  const tag = `${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  const outFile = join(LOGS, `.ff-${tag}.out`);
  const errFile = join(LOGS, `.ff-${tag}.err`);
  return new Promise((resolve, reject) => {
    let fdOut, fdErr;
    try {
      fdOut = openSync(outFile, "w");
      fdErr = openSync(errFile, "w");
    } catch (err) {
      return reject(err);
    }
    const child = spawn(bin, args, { stdio: ["ignore", fdOut, fdErr], windowsHide: true, cwd, env });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`ffmpeg 超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);

    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { closeSync(fdOut); } catch { /* ignore */ }
      try { closeSync(fdErr); } catch { /* ignore */ }
      let stdout = "";
      let stderr = "";
      try { stdout = readFileSync(outFile, "utf8"); } catch { /* ignore */ }
      try { stderr = readFileSync(errFile, "utf8"); } catch { /* ignore */ }
      try { rmSync(outFile, { force: true }); } catch { /* ignore */ }
      try { rmSync(errFile, { force: true }); } catch { /* ignore */ }
      if (err) return reject(Object.assign(err, { stdout, stderr }));
      resolve({ code: child.exitCode, stdout, stderr });
    };

    child.on("error", (err) => finish(err));
    child.on("close", (code) => {
      if (code !== 0) {
        const err = new Error(`ffmpeg 退出码 ${code}：${tail(stderrText(), 3)}`);
        err.code = code;
        return finish(err);
      }
      finish(null);
    });

    function stderrText() {
      try { return readFileSync(errFile, "utf8"); } catch { return ""; }
    }
  });
}

function tail(s, n = 3) {
  return String(s || "").trim().split(/\r?\n/).slice(-n).join(" | ").slice(0, 300);
}

export async function probeAudio(file) {
  const { stdout } = await run(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "json",
    file,
  ]);
  const j = JSON.parse(stdout);
  return { duration: Number(j.format?.duration || 0) };
}

export async function probeMedia(file) {
  const { stdout } = await run(FFPROBE, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,duration,codec_name",
    "-show_entries", "format=duration,size",
    "-of", "json",
    file,
  ]);
  const j = JSON.parse(stdout);
  const s = j.streams?.[0] || {};
  return {
    width: s.width,
    height: s.height,
    duration: Number(j.format?.duration || s.duration || 0),
    size: Number(j.format?.size || 0),
    codec: s.codec_name,
  };
}

/**
 * 生成 4×4 接触印相纸：每 step 秒取一帧，缩到 cell 宽，16 帧拼一张。
 * 返回每张图覆盖的时间范围，方便读图时定位。
 */
export function hsvFrame(rgb) {
  const hsv = new Float32Array(rgb.length);
  for (let i = 0; i < rgb.length; i += 3) {
    const r = rgb[i] / 255, g = rgb[i + 1] / 255, b = rgb[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    let h = 0;
    if (delta) h = (max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) / 6;
    hsv[i] = (h + 1) % 1;
    hsv[i + 1] = max ? delta / max : 0;
    hsv[i + 2] = max;
  }
  return hsv;
}

export function hsvDifference(a, b) {
  let total = 0;
  for (let i = 0; i < a.length; i += 3) {
    const hue = Math.abs(a[i] - b[i]);
    total += Math.min(hue, 1 - hue) * 2 * Math.min(a[i + 1], b[i + 1])
      + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  }
  return total / a.length;
}

/**
 * 相对本地基线找切点：分数得"比它附近的常态高很多"才算一刀。
 * 思路来自 dsh-video-storyboard 的 scan.js（MIT）：固定阈值对 PPT（平时 0.05、换页 0.6）
 * 和匀速运镜（基线本来就高）都无解，只有跟本地中位数比才有意义。
 * @param {Array<{at:number, score:number}>} stats
 */
export function spikeCuts(stats, { k = 3, minAbs = 6 / 255, halfWindow = 15 } = {}) {
  if (!Array.isArray(stats) || stats.length < 3) return [];
  const scores = stats.map((s) => s.score);
  const sorted = [...scores].sort((a, b) => a - b);
  const median = (arr) => (arr.length ? arr[Math.floor(arr.length / 2)] : 0);
  const global = median(sorted);
  const out = [];
  for (let i = 0; i < stats.length; i++) {
    const lo = Math.max(0, i - halfWindow);
    const hi = Math.min(stats.length, i + halfWindow + 1);
    const around = [...scores.slice(lo, i), ...scores.slice(i + 1, hi)].sort((a, b) => a - b);
    const base = Math.max(0.2 / 255, Math.min(median(around) || global, global));
    const need = Math.max(minAbs, base * k);
    if (scores[i] > need) out.push({ at: stats[i].at, score: stats[i].score, ratio: +(scores[i] / base).toFixed(1) });
  }
  return out;
}

/**
 * 速率法定阈值：目标是"大约每 minGap 秒一个切点"，取分数分布里对应的分位。
 * 比"p95×3"稳——快剪 PV 的 p95 本身就很高，乘 3 会把阈值推到切点带里面去。
 */
export function rateThreshold(scores, { duration, minGap = 0.5, floor = 12 / 255 } = {}) {
  if (!scores.length) return floor;
  const sorted = [...scores].sort((a, b) => a - b);
  const n = sorted.length;
  const total = duration > 0 ? duration : n * 0.25;
  const gap = Math.min(1.5, Math.max(minGap, total / 60));
  const target = Math.max(1, Math.min(n * 0.25, total / gap));
  const idx = Math.max(0, Math.min(n - 1, Math.floor(n - target)));
  return Math.max(floor, sorted[idx]);
}

/** 切点计数是否不可信（连续运镜会被逐帧切成"切点"，cuts=N 就没有节奏含义了）。 */
export function assessDegraded({ span, cuts, hotRatio, scoreCv, scoreMean }) {
  if (!(span > 0) || !(cuts > 0)) return null;
  if (span / cuts >= 0.5 || hotRatio <= 0.3) return null;
  if (typeof scoreCv === "number" && scoreCv >= 0.4 && (scoreMean ?? 0) >= 0.118) return null;
  return "motion";
}

export async function scanScenes(videoFile, { from = 0, to, sampleStep = 0.25, cutMode = "fixed", threshold = 0.12, spikeK = 3, spikeMinAbs = 6 / 255 } = {}) {
  ensureDirs();
  const raw = join(LOGS, `scan-${process.pid}-${Math.random().toString(16).slice(2)}.rgb`);
  const step = Math.max(sampleStep, (to - from) / 12000);
  try {
    await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(from), "-i", videoFile,
      "-t", String(to - from), "-vf", `fps=1/${step},scale=64:36`, "-f", "rawvideo", "-pix_fmt", "rgb24", raw]);
    const bytes = await readFile(raw), frameBytes = 64 * 36 * 3;
    const stats = [];
    let previous;
    for (let offset = 0, n = 0; offset + frameBytes <= bytes.length; offset += frameBytes, n++) {
      const current = hsvFrame(bytes.subarray(offset, offset + frameBytes));
      const score = previous ? hsvDifference(previous, current) : 0;
      stats.push({ at: from + n * step, score });
      previous = current;
    }
    const inside = stats.filter((s) => s.at > from && s.at < to);
    let cuts;
    if (cutMode === "spike") {
      cuts = spikeCuts(inside, { k: spikeK, minAbs: spikeMinAbs });
    } else if (cutMode === "auto") {
      const limit = rateThreshold(inside.map((s) => s.score), { duration: to - from, minGap: step * 2 });
      cuts = inside.filter((s) => s.score > limit).map((s) => ({ at: s.at, score: s.score }));
    } else {
      cuts = inside.filter((s) => s.score >= threshold).map((s) => ({ at: s.at, score: s.score }));
    }
    // 元信息挂在数组上：老调用方按数组用，新代码可以读 cuts.meta 判断可信度
    const scores = inside.map((s) => s.score);
    const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const sd = scores.length ? Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length) : 0;
    const hotRatio = scores.length ? scores.filter((s) => s > 0.12).length / scores.length : 0;
    // 真正的 medianShot：相邻切点间隔的中位数（原来是 span/cuts，那是平均镜头长，名字撒谎）
    const marks = [from, ...cuts.map((c) => c.at).sort((a, b) => a - b), to];
    const gaps = marks.slice(1).map((t, i) => t - marks[i]).sort((a, b) => a - b);
    const medianShot = gaps.length ? +gaps[Math.floor(gaps.length / 2)].toFixed(2) : null;
    const meanShot = cuts.length ? +((to - from) / cuts.length).toFixed(2) : null;
    cuts.meta = {
      mode: cutMode,
      frames: scores.length,
      // 降级判据仍用平均镜头（这是原实现的定义），medianShot 只用于报告与复核
      degraded: assessDegraded({ span: to - from, cuts: cuts.length, hotRatio, scoreCv: mean ? sd / mean : 0, scoreMean: mean }),
      medianShot,
      meanShot,
    };
    return cuts;
  } finally { await rm(raw, { force: true }); }
}

/** Equal increments of a local cut-density integral, with bounded snapping to cuts. */
export function planCells({ from = 0, to, count, cuts = [] }) {
  const bins = Math.max(1, Math.ceil((to - from) / 0.25)), width = (to - from) / bins;
  const mass = Array(bins).fill(width);
  for (const cut of cuts) {
    const center = Math.floor((cut.at - from) / width), radius = Math.ceil(2 / width);
    for (let i = Math.max(0, center - radius); i <= Math.min(bins - 1, center + radius); i++) mass[i] += width * 2;
  }
  const cumulative = [0];
  for (const value of mass) cumulative.push(cumulative.at(-1) + value);
  const bounds = [from], ideal = (to - from) / count;
  let bin = 0;
  for (let n = 1; n < count; n++) {
    const target = cumulative.at(-1) * n / count;
    while (bin < bins - 1 && cumulative[bin + 1] < target) bin++;
    let at = from + (bin + (target - cumulative[bin]) / mass[bin]) * width;
    const near = cuts.reduce((best, c) => Math.abs(c.at - at) < Math.abs(best - at) ? c.at : best, Infinity);
    if (Math.abs(near - at) <= ideal * 0.3 && near > bounds.at(-1) + 0.05 && near < to - 0.05) at = near;
    bounds.push(Math.min(to - (count - n) * 0.001, Math.max(bounds.at(-1) + 0.001, at)));
  }
  bounds.push(to);
  return bounds.slice(0, -1).map((start, i) => ({ from: start, to: bounds[i + 1], at: (start + bounds[i + 1]) / 2 }));
}

export async function writeSheetIndex(outDir, sheets) {
  const lines = [];
  for (const sheet of sheets) {
    lines.push(`${sheet.file.split(/[\\/]/).pop()}\t${fmtClock(sheet.from)}-${fmtClock(sheet.to)}`);
    for (const c of sheet.cells || []) lines.push(`  cell ${c.index + 1} [${fmtClock(c.from)}-${fmtClock(c.to)}] @${c.at.toFixed(3)}s  ${(c.subtitles || []).map((s) => s.text).join(" / ")}`);
  }
  await writeTextAtomic(join(outDir, "INDEX.txt"), lines.join("\n") + "\n");
}

export async function buildSheets(videoFile, outDir, { step = 5, grid = 4, cell = 384, quality = 3,
  maxSheets = 20, from = 0, to, mode = "scene", subtitles = [], log = () => {} } = {}) {
  for (const [name, value] of Object.entries({ step, grid, cell, maxSheets })) {
    if (!(Number.isFinite(value) && value > 0) || (name !== "step" && !Number.isInteger(value))) throw new Error(`无效参数 ${name}: ${value}`);
  }
  if (!["scene", "uniform"].includes(mode)) throw new Error("mode 必须是 scene 或 uniform");
  const media = await probeMedia(videoFile);
  const baseName = basename(videoFile);
  const srcStat = await stat(videoFile).catch(() => null);
  to = Math.min(to ?? media.duration, media.duration);
  if (!(Number.isFinite(from) && from >= 0 && Number.isFinite(to) && to > from)) throw new Error("抽帧时间窗超出视频范围");
  await mkdir(outDir, { recursive: true });
  let cuts = [], fallback = null;
  if (mode === "scene") {
    try { cuts = await scanScenes(videoFile, { from, to }); }
    catch (err) { fallback = err.message; mode = "uniform"; log(`场景扫描失败，使用等间隔：${err.message}`); }
  }
  const per = grid * grid;
  const count = Math.min(maxSheets * per, Math.max(1, Math.ceil((to - from) / step), cuts.length + 1), Math.max(1, Math.floor((to - from) * 25)));
  const cells = planCells({ from, to, count, cuts });
  // Quantize the representative frame to the fps filter's clock; metadata uses the same clock.
  const fps = Math.min(1000, Math.max(4, Math.ceil(2 / Math.min(...cells.map((c) => c.to - c.from)))));
  for (const c of cells) c.at = from + Math.round((c.at - from) * fps) / fps;
  // FFmpeg's expression parser has a recursion limit: a flat 100+ term sum fails with ENOMEM.
  const terms = cells.map((c) => `eq(n,${Math.round((c.at - from) * fps)})`);
  const sum = (items) => items.length === 1 ? items[0]
    : `(${sum(items.slice(0, Math.floor(items.length / 2)))}+${sum(items.slice(Math.floor(items.length / 2)))})`;
  const select = sum(terms);
  const tag = `pending_${process.pid}_${Date.now()}_`;
  try {
    await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(from), "-i", videoFile, "-t", String(to - from),
      "-vf", `fps=${fps},select='${select}',scale=${cell}:-2,tile=${grid}x${grid}:nb_frames=${per}`,
      "-fps_mode", "vfr", "-q:v", String(quality), "-frames:v", String(maxSheets), join(outDir, tag + "%03d.jpg")]);
    const pending = (await readdir(outDir)).filter((f) => f.startsWith(tag) && f.endsWith(".jpg")).sort();
    if (pending.length !== Math.ceil(cells.length / per)) throw new Error("生成拼图数量与抽帧计划不一致");
    for (const old of (await readdir(outDir)).filter((f) => /^sheet_\d+\.jpg$/.test(f))) await rm(join(outDir, old));
    let sheets = [];
    for (let i = 0; i < pending.length; i++) {
      const file = join(outDir, `sheet_${String(i + 1).padStart(3, "0")}.jpg`);
      await rename(join(outDir, pending[i]), file);
      const chunk = cells.slice(i * per, (i + 1) * per).map((c, index) => ({ ...c, index, row: Math.floor(index / grid) + 1, column: index % grid + 1 }));
      sheets.push({ file, from: chunk[0].from, to: chunk.at(-1).to, frames: chunk.map((c) => c.at), cells: chunk, mode, sceneCuts: cuts.length, fallback });
    }
    sheets = alignSheets(sheets, subtitles);
    // 切点可信度：连续运镜会被逐帧切成"切点"，此时 cuts=N 没有节奏含义，只是密度。
    // 这个标记来自 dsh-video-storyboard 的 assessDegraded 思路（MIT）。
    const degraded = cuts.meta?.degraded ?? null;
    if (degraded === "motion") log("切点不可信（连续运镜/甩镜），cuts 只当密度参考");
    const cutsIn = (a, b) => cuts.filter((c) => c.at >= a && c.at < b).length;
    const charsIn = (a, b) => subtitles.reduce((sum, s) => sum + (s.from < b && s.to > a ? (s.text || "").length : 0), 0);
    await writeJsonAtomic(join(outDir, "sheets.json"), {
      version: 2, from, to, grid, step, mode, degraded,
      medianShot: cuts.meta?.medianShot ?? null,
      sheets: sheets.map((s) => ({ ...s, file: s.file.split(/[\\/]/).pop() })),
    });
    // evidence.json：给人和脚本复核用（每格起止、取帧时刻、刀数、字数、对应字幕段），不是给模型读的散文
    const spanOf = (a, b) => {
      const hit = subtitles.filter((s) => s.to > a && s.from < b);
      return hit.length ? { from: +hit[0].from.toFixed(2), to: +hit.at(-1).to.toFixed(2), lines: hit.length } : null;
    };
    await writeJsonAtomic(join(outDir, "evidence.json"), {
      version: 2,
      from: +from.toFixed(2), to: +to.toFixed(2), grid, mode, degraded,
      sceneCuts: cuts.length, medianShot: cuts.meta?.medianShot ?? null, meanShot: cuts.meta?.meanShot ?? null,
      fallback,
      // 分析参数与来源指纹：三个月后回看，得知道这份证据是哪套参数、哪条片、哪个文件的
      params: { step: +Number(step).toFixed(3), cell, grid, maxSheets, mode, cutMode: cuts.meta?.mode ?? null, threshold: mode === "scene" ? 0.12 : null },
      source: { file: baseName, bytes: srcStat?.size ?? null, duration: +media.duration.toFixed(2) },
      cells: cells.map((c, i) => ({
        sheet: Math.floor(i / per) + 1,
        cell: (i % per) + 1,
        from: +c.from.toFixed(2),
        to: +c.to.toFixed(2),
        frame: +c.at.toFixed(2),
        cuts: cutsIn(c.from, c.to),
        chars: charsIn(c.from, c.to),
        subtitleSpan: spanOf(c.from, c.to),
      })),
    });
    await writeSheetIndex(outDir, sheets);
    // 让调用方（sheet 命令）能把降级标记同步进 packet，而不是等下一次 pack
    sheets.degraded = degraded;
    sheets.medianShot = cuts.meta?.medianShot ?? null;
    return sheets;
  } finally {
    for (const file of (await readdir(outDir)).filter((f) => f.startsWith(tag))) await rm(join(outDir, file), { force: true });
  }
}

/** 单帧回读（核对参数/字幕）。 */
export async function grabFrame(videoFile, atSec, outFile, { width = 960 } = {}) {
  await mkdir(outFile.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
  await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", String(Math.max(0, atSec)),
    "-i", videoFile,
    "-frames:v", "1",
    "-vf", `scale=${width}:-2`,
    "-q:v", "2",
    outFile,
  ]);
  return outFile;
}

/** 抽音频（16k 单声道 wav，给 ASR 用）。 */
export async function extractAudio(videoFile, outFile, { start, duration } = {}) {
  await mkdir(outFile.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  if (start) args.push("-ss", String(start));
  args.push("-i", videoFile);
  if (duration) args.push("-t", String(duration));
  args.push("-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outFile);
  await run(FFMPEG, args);
  return outFile;
}

/** 底部字幕带：把整片硬字幕裁成一张竖图（对齐 bili-watch 的 substrip 思路）。 */
export async function buildSubStrip(videoFile, outFile, { step = 3, crop = 0.18, width = 960, from = 0, to, maxFrames = 80 } = {}) {
  await mkdir(outFile.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
  // 先按整宽缩放到 width，再裁底部 crop 比例，最后竖向拼接
  if (!(step > 0 && width > 0 && crop > 0 && crop <= 1 && Number.isInteger(maxFrames) && maxFrames > 0)) throw new Error("无效字幕带参数");
  const media = await probeMedia(videoFile);
  const end = Math.min(to ?? media.duration, media.duration);
  if (!(from >= 0 && end > from)) throw new Error("字幕带时间窗无效");
  const count = Math.min(maxFrames, Math.max(1, Math.ceil((end - from) / step)));
  step = (end - from) / count;
  const h = Math.max(2, Math.floor(media.height * width / media.width * crop / 2) * 2);
  await run(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", String(from), "-i", videoFile, "-t", String(end - from),
    "-vf", `fps=1/${step},scale=${width}:-2,crop=${width}:${h}:0:ih-${h},tile=1x${count}:nb_frames=${count}`,
    "-frames:v", "1",
    "-q:v", "2",
    outFile,
  ]);
  return outFile;
}
