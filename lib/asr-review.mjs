// 本地转写的证伪：这段字是「听到了」还是「编出来的」。
//
// 判据与保守度移植自 xinhailaopo/video-watch-plus 的 scripts/asr_hallucination_check.py（MIT），
// 并沿用 vendor/bili-watch/tools/look.mjs::verifyAsr 的落地经验（同一来源，已在本仓库 vendor 里验证过一轮）：
//   ① 声学侧（这里用 16k wav 的响度活跃度）几乎没有声音，却转出了字 → 存疑
//   ② 互不重叠的时间窗输出同一段文本 → 真实语音不会这样
//   ③ 全片只落在一两句模板幻觉句上 → 存疑（whisper 在无人声音轨上的典型签名）
//
// 与上游的差异：whisper.cpp 的 -oj 不提供 no_speech_prob / avg_logprob，那两路直接缺席，
// 剩下的两路必须自己扛住——所以这里只标 suspect 提示复核，绝不自动删稿、不跳过 ASR。

const INDEP_GAP_SEC = 2; // 相邻两段间隔 <2s 视为同一次发言被切开，不算独立窗口
const MIN_TEXT_CHARS = 6; // 太短的段（"对""嗯"）不参与重复统计
const DUP_SHARE = 0.5; // 重复段占全片一半以上才判，正常口播反复强调也常见
const DUP_REVIEW_SHARE = 0.15; // 低于这个比例只是零星重复（口头禅、片头口号），不进提示
const LOW_ACTIVITY = 0.15; // 有声窗占比低于 15%：整条音轨基本是静音/纯音乐
const MIN_SILENCE_SEC = 1;

/** 去掉空白与标点再比，避免"同义但断句不同"逃过重复检测。 */
export function normalizeSpeech(text) {
  return String(text ?? "").replace(/[\s，。、！？；：,.!?;:"'“”‘’（）()【】「」『』…—–\-]/g, "");
}

// whisper 在没人声的音轨上最常编出来的中文模板句（只作为"短语料 + 命中"的旁证，单独不定案）
const TEMPLATE_HINTS = [
  /字幕由.{0,10}提供/,
  /请不吝点赞/,
  /钉钉|明镜与点点/,
  /订阅.{0,6}转发.{0,6}打赏/,
  /打赏支持.{0,10}(栏目|频道|节目)/,
  /^(感谢|谢谢)(大家)?观看/,
];

function looksLikeTemplate(text) {
  const t = String(text ?? "");
  return TEMPLATE_HINTS.some((re) => re.test(t));
}

/**
 * 互不重叠的时间窗里是否出现同一段文本。
 * @param {Array<{from:number,to:number,text:string}>} segments
 * @returns {{repeated: Array<{text:string,count:number,at:number[]}>, dupSegments:number}}
 */
export function findRepeatedWindows(segments = []) {
  const groups = new Map();
  for (const s of segments) {
    const key = normalizeSpeech(s?.text);
    if (key.length < MIN_TEXT_CHARS) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const repeated = [];
  let dupSegments = 0;
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    let independent = false;
    for (let i = 1; i < list.length; i++) {
      if (Number(list[i].from) - Number(list[i - 1].to) >= INDEP_GAP_SEC) { independent = true; break; }
    }
    if (!independent) continue;
    dupSegments += list.length;
    repeated.push({
      text: String(list[0].text ?? "").trim(),
      count: list.length,
      at: list.map((s) => +Number(s.from).toFixed(1)),
    });
  }
  return { repeated, dupSegments };
}

/**
 * 综合文本与声学两路证据，给本地转写一个可信度标记。
 * @param {{segments?:Array, duration?:number, activity?:{ok:boolean,activeRatio:number,longestSilence:number,seconds:number}|null}} input
 * @returns {{level:'none'|'review'|'suspect', reasons:string[], stats:object}}
 */
export function assessAsrEvidence({ segments = [], duration = 0, activity = null } = {}) {
  const stats = {
    segments: segments.length,
    chars: segments.reduce((n, s) => n + String(s?.text ?? "").length, 0),
    duration: +Number(duration || 0).toFixed(1),
    activity: activity && activity.ok
      ? { activeRatio: activity.activeRatio, longestSilence: activity.longestSilence }
      : null,
  };
  if (!segments.length) return { level: "none", reasons: ["没有分段可供判定"], stats };

  const reasons = [];
  let level = "none";
  const raise = (next) => { if (next === "suspect" || level === "none") level = next; };

  const { repeated, dupSegments } = findRepeatedWindows(segments);
  stats.dupSegments = dupSegments;
  stats.dupTexts = repeated.length;
  if (repeated.length && dupSegments * 2 >= segments.length) {
    raise("suspect");
    const sample = repeated.slice(0, 2)
      .map((r) => `「${r.text.slice(0, 14)}」出现在 ${r.at.slice(0, 6).join(" / ")}${r.at.length > 6 ? " …" : ""}s`).join("；");
    reasons.push(`同一段文本反复出现在隔开的时间窗（${sample}）`);
  } else if (repeated.length && dupSegments / segments.length >= DUP_REVIEW_SHARE) {
    raise("review");
    reasons.push(`${dupSegments}/${segments.length} 段文本在独立窗口重复，未过半，仅记一笔`);
  }

  if (activity?.ok) {
    if (activity.activeRatio <= LOW_ACTIVITY) {
      raise("suspect");
      reasons.push(`声学侧只有 ${(activity.activeRatio * 100).toFixed(0)}% 的窗有声音，却转出 ${stats.chars} 字；最长静音 ${activity.longestSilence}s`);
    } else if (activity.longestSilence >= Math.max(MIN_SILENCE_SEC, stats.duration * 0.5) && duration > 0) {
      raise("review");
      reasons.push(`最长连续静音 ${activity.longestSilence}s，占片长 ${((activity.longestSilence / stats.duration) * 100).toFixed(0)}%`);
    }
  } else {
    reasons.push("没有声学证据（未取到音频活跃度），只剩文本一路");
    raise("review");
  }

  if (segments.length <= 2) {
    const templateHits = segments.filter((s) => looksLikeTemplate(s.text)).length;
    if (templateHits) {
      raise("suspect");
      reasons.push(`全片仅 ${segments.length} 段且命中幻觉模板句「${String(segments[0]?.text ?? "").slice(0, 20)}」`);
    }
  }

  return { level, reasons, stats };
}

/** 把结论压成一行，给 warnings 与 READING.md 用。 */
export function describeAsrEvidence(evidence) {
  if (!evidence) return null;
  if (evidence.level === "suspect") return `本地转写存疑：${evidence.reasons.join("；")}`;
  if (evidence.level === "review") return `本地转写待复核：${evidence.reasons.join("；")}`;
  return null;
}
