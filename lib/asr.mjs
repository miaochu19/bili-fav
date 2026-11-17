import { join, relative } from "node:path";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";

import { ROOT, CACHE } from "./paths.mjs";
import { readJson, writeTextAtomic, writeJsonAtomic } from "./fsx.mjs";
import { parseClock, filterSuspectSegments, transcriptClock } from "./transcript.mjs";
import { run, WHISPER, WHISPER_MODELS } from "./frames.mjs";

/**
 * whisper.cpp 在含中文的绝对路径下会崩（0xC0000409），
 * 但用相对路径 + cwd=项目根目录就正常。这里统一走相对路径。
 */
function rel(p) {
  return relative(ROOT, p).replace(/\\/g, "/");
}

function pickModel(name) {
  if (name && name !== "auto") {
    return join(WHISPER_MODELS, name.endsWith(".bin") ? name : `ggml-${name}.bin`);
  }
  const preferred = ["ggml-small-q5_1.bin", "ggml-small.bin", "ggml-base.bin", "ggml-tiny.bin"];
  for (const m of preferred) {
    if (existsSync(join(WHISPER_MODELS, m))) return join(WHISPER_MODELS, m);
  }
  return join(WHISPER_MODELS, "ggml-small-q5_1.bin");
}

export async function asrModelKey(name) {
  const path = pickModel(name), info = await stat(path).catch(() => null);
  return `${path.split(/[\\/]/).pop()}|${info?.size || 0}|${info?.mtimeMs || 0}|zh|ml30|filter1`;
}

export function whisperSegments(json) {
  return (json.transcription || []).map((seg) => ({
    from: seg.timestamps?.from != null ? parseClock(seg.timestamps.from) : Number(seg.offsets?.from) / 1000,
    to: seg.timestamps?.to != null ? parseClock(seg.timestamps.to) : Number(seg.offsets?.to) / 1000,
    text: String(seg.text || "").trim(),
  }));
}

/**
 * 对 16k 单声道 wav 做转写，产出 [起-止] 文本，写入 <cache>/<bvid>/transcript.txt。
 */
export async function transcribe(wavAbs, { bvid, model, threads, lang = "zh", duration = Infinity, maxLength = 30, vadModel, outDir } = {}) {
  const modelPath = pickModel(model);
  const base = join(outDir || join(CACHE, bvid), "asr");
  const args = [
    "-m", rel(modelPath),
    "-f", rel(wavAbs),
    "-l", lang,
    "-ml", String(maxLength),
    "-oj",
    "-of", rel(base),
  ];
  if (threads) args.push("-t", String(threads));
  if (vadModel) args.push("--vad", "-vm", rel(vadModel));

  await run(WHISPER, args, { cwd: ROOT, timeoutMs: 3 * 60 * 60 * 1000 });

  const json = await readJson(`${base}.json`, null);
  if (!json || !Array.isArray(json.transcription)) throw new Error("转写没有产出 JSON，检查 whisper 是否可用");

  const filtered = filterSuspectSegments(whisperSegments(json), { duration });
  const lines = filtered.segments.map(({ from, to, text }) => `[${transcriptClock(from)}-${transcriptClock(to)}] ${text}`);
  if (!lines.length) throw new Error("ASR 无可用文本（纯音乐/静音或全部被过滤），保留原有转写");

  const transcript = join(outDir || join(CACHE, bvid), "transcript.asr.txt");
  const header = `# 本地转写（whisper.cpp ${modelPath.split(/[\\/]/).pop()}）\nBV: ${bvid}\n共 ${lines.length} 段\n\n`;
  await writeTextAtomic(transcript, header + lines.join("\n") + "\n");
  await writeJsonAtomic(`${base}.filtered.json`, filtered);

  const chars = lines.reduce((s, l) => s + l.replace(/^\[[^\]]+\]\s*/, "").length, 0);

  return {
    transcript,
    lines: lines.length,
    chars,
    segments: filtered.segments,
    discardedCount: filtered.discardedCount,
    discarded: filtered.discarded,
    preview: lines.slice(0, 2).join("  ").slice(0, 160),
  };
}
