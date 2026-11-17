// 音频包络：从 16k 单声道 WAV 里算每 0.5 秒的响度，产出"变响/变静"事件。
// 只回答"哪里突然有声/突然安静"，不猜音乐还是人声、不猜谁在说话——
// 那是 ASR/说话人分离的活，我们没做，也不假装做了。
import { readFile } from "node:fs/promises";

function parseWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("不是 WAV 文件");
  }
  let offset = 12, fmt = null, data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = buf.subarray(body, Math.min(buf.length, body + size));
    }
    offset = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("WAV 缺 fmt/data 块");
  if (fmt.bits !== 16) throw new Error(`只支持 16-bit PCM，拿到 ${fmt.bits}-bit`);
  return { ...fmt, data };
}

const toDb = (rms) => (rms <= 0 ? -120 : 20 * Math.log10(rms / 32768));

/** 每 window 秒一个 RMS(dBFS)。 */
export function loudnessCurve(wav, { window = 0.5 } = {}) {
  const { data, channels, sampleRate } = wav;
  const frameBytes = 2 * channels;
  const total = Math.floor(data.length / frameBytes);
  const step = Math.max(1, Math.round(sampleRate * window));
  const curve = [];
  for (let start = 0; start < total; start += step) {
    const end = Math.min(total, start + step);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const v = data.readInt16LE(i * frameBytes); // 取第一声道即可（我们抽的是单声道）
      sum += v * v;
    }
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    curve.push({ at: +(start / sampleRate).toFixed(2), db: +toDb(rms).toFixed(1) });
  }
  return curve;
}

/**
 * 把响应曲线折成事件：显著变响 / 显著变静 / 静音段。
 * @returns {{events: Array<{at:number, type:'louder'|'quieter', delta:number, db:number}>,
 *            silence: Array<{from:number, to:number}>, stats:{medianDb:number, loudRatio:number}}}
 */
export function loudnessEvents(curve, { deltaDb = 8, silenceDb = -45, minGap = 4 } = {}) {
  if (!curve.length) return { events: [], silence: [], stats: { medianDb: -120, loudRatio: 0 } };
  const sorted = curve.map((c) => c.db).sort((a, b) => a - b);
  const medianDb = sorted[Math.floor(sorted.length / 2)];
  // 先做 3 窗中值平滑：逐窗差分在音乐/噪声上会一秒一个事件，平滑后才像"段落级"的变化
  const smooth = curve.map((c, i) => {
    const near = [curve[i - 1], c, curve[i + 1]].filter(Boolean).map((x) => x.db).sort((a, b) => a - b);
    return { at: c.at, db: near[Math.floor(near.length / 2)] };
  });
  const events = [];
  for (let i = 1; i < smooth.length; i++) {
    const delta = smooth[i].db - smooth[i - 1].db;
    if (Math.abs(delta) < deltaDb) continue;
    // 两端都是静音时，"变响"没有意义（是噪声底在跳）
    if (smooth[i].db <= silenceDb && smooth[i - 1].db <= silenceDb) continue;
    const last = events.at(-1);
    if (last && smooth[i].at - last.at < minGap) continue;
    events.push({ at: smooth[i].at, type: delta > 0 ? "louder" : "quieter", delta: +delta.toFixed(1), db: smooth[i].db });
  }
  const silence = [];
  let open = null;
  for (const c of curve) {
    if (c.db <= silenceDb) {
      if (!open) open = { from: c.at, to: c.at };
      else open.to = c.at;
    } else if (open) {
      // 太短的静音（<1s）多半是换气/剪辑气口，不记
      if (open.to - open.from >= 1) silence.push(open);
      open = null;
    }
  }
  if (open && open.to - open.from >= 1) silence.push(open);
  const loudRatio = +(curve.filter((c) => c.db > silenceDb).length / curve.length).toFixed(2);
  return { events, silence, stats: { medianDb, loudRatio } };
}

/** 一步到位：读 WAV → 曲线 → 事件。 */
export async function analyzeLoudness(wavFile, opts = {}) {
  const wav = parseWav(await readFile(wavFile));
  const curve = loudnessCurve(wav, { window: opts.window ?? 0.5 });
  const folded = loudnessEvents(curve, opts);
  return { ...folded, curve, seconds: curve.length * (opts.window ?? 0.5) };
}

/**
 * 活跃度统计：给「本地转写证伪」当声学旁证用（见 lib/asr-review.mjs）。
 * 只回答「这条音轨有多少时间是有声的、最长连续安静多久」，仍然不猜人声还是音乐。
 * @returns {{ok:boolean, seconds:number, activeRatio:number, longestSilence:number, medianDb:number|null}}
 */
export function activityStats(curve, { silenceDb = -45 } = {}) {
  if (!Array.isArray(curve) || !curve.length) {
    return { ok: false, seconds: 0, activeRatio: 0, longestSilence: 0, medianDb: null };
  }
  const window = 0.5;
  const active = curve.filter((c) => c.db > silenceDb);
  let longest = 0, open = null;
  for (const c of curve) {
    if (c.db <= silenceDb) {
      if (open == null) open = c.at;
      longest = Math.max(longest, c.at + window - open);
    } else open = null;
  }
  const sorted = curve.map((c) => c.db).sort((a, b) => a - b);
  return {
    ok: true,
    seconds: +(curve.length * window).toFixed(1),
    activeRatio: +(active.length / curve.length).toFixed(3),
    longestSilence: +longest.toFixed(1),
    medianDb: sorted[Math.floor(sorted.length / 2)],
  };
}

/** 一步到位：读 WAV → 活跃度统计（不做事件折叠）。 */
export async function analyzeAudioActivity(wavFile, opts = {}) {
  const wav = parseWav(await readFile(wavFile));
  return activityStats(loudnessCurve(wav, { window: opts.window ?? 0.5 }), opts);
}
