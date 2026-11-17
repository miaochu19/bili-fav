import { join } from "node:path";
import { mkdir, readFile, copyFile } from "node:fs/promises";
import { CACHE } from "./paths.mjs";
import { readJson, writeJsonAtomic, writeTextAtomic } from "./fsx.mjs";
import { openMaterials } from "./materials.mjs";
import { readTranscriptCache, saveTranscriptCache, digest } from "./material-cache.mjs";
import { ensureAudioFile, fmtClock } from "./media.mjs";
import { extractAudio, probeAudio } from "./frames.mjs";
import { transcribe, asrModelKey } from "./asr.mjs";
import { analyzeAudioActivity } from "./loudness.mjs";
import { assessAsrEvidence, describeAsrEvidence } from "./asr-review.mjs";
import { parseTranscript, transcriptClock } from "./transcript.mjs";
import { assessSubtitle, stopOnAccountError } from "./subtitle-quality.mjs";
import { noteBudget } from "./quality.mjs";
import { readingArtifacts } from "./outline.mjs";
import { collectAudience } from "./audience-materials.mjs";

export async function buildMaterialPacket(api, bvid, { favs = null, log = () => {}, asr = false, forceAsr = false,
  asrModel, maxAsrMinutes = 60, refresh = false, offline = false, comments = 5, danmaku = true,
  commentsOnly = false, commentsMode = "all", maxCommentPages = 80, depth = "auto",
  cacheRoot = CACHE, services = {}, resolveSubtitle, findSheets, onDownloadProgress } = {}) {
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) throw new Error("需要有效 BV 号");
  if (offline && (refresh || forceAsr)) throw new Error("--offline 不能同时要求刷新或强制 ASR");
  // 评论区可以"尽量看完"（Infinity = all），也可以指定条数；1000 条 ≈ 50 页，够覆盖绝大多数视频。
  if (!(comments === Infinity || Number.isInteger(comments) && comments >= 0 && comments <= 1000))
    throw new Error("--comments 必须是 0–1000 或 all");
  if (!["hot", "time", "all"].includes(commentsMode)) throw new Error("--comments-mode 必须是 hot / time / all");
  if (!Number.isInteger(maxCommentPages) || maxCommentPages < 1 || maxCommentPages > 200)
    throw new Error("--max-comment-pages 必须是 1–200");
  if (commentsOnly && comments < 1) throw new Error("--comments-only 至少需要 --comments 1");
  noteBudget(0, { depth }); // Validate before any work.
  const context = await openMaterials(api, bvid, { cacheRoot, refresh, offline, services });
  const { dir, view, cid, identity } = context;
  await mkdir(dir, { recursive: true });
  const io = { ensureAudioFile, extractAudio, probeAudio, transcribe, asrModelKey, ...services };
  const modelKey = await io.asrModelKey(asrModel);
  const oldPacket = await readJson(join(dir, "packet.json"), null);
  const priorMeta = await readJson(join(dir, "transcript.meta.json"), null).catch(() => null);
  if (priorMeta && !refresh && !forceAsr) {
    const priorText = await readFile(join(dir, "transcript.txt"), "utf8").catch(() => null);
    if (priorText && priorMeta.sha256 !== digest(priorText)) throw new Error("转写文字与保存的指纹不符，已保留原文件；先确认人工修改，再显式 --refresh 重取");
  }
  let cached = !refresh && !forceAsr ? await readTranscriptCache(dir, identity, { modelKey, oldPacket }) : null;
  const warnings = [];
  if (view.argue) warnings.push(`官方内容标注：${view.argue}（作者的判断/演示未必等于实测，引用前自判）`);
  if (cached?.meta.source === "asr") warnings.push(...(oldPacket?.materials?.warnings || []).filter((w) => /原字幕.*已改用本地转写/.test(w)));
  if (view.multiPart) warnings.push(`多 P：仅处理第 1/${view.pageCount} P「${view.part}」，本 P ${fmtClock(view.duration)}`);
  let text = cached?.text || null, segments = cached?.segments || [], source = cached?.meta.source || null;
  let subCheck = cached?.meta.subtitleCheck || null, subtitleLang = cached?.meta.language || null;
  let asrDiscardedCount = cached?.meta.discardedCount || 0, resolved = null;
  let asrEvidence = cached?.meta.asrEvidence || null;
  if (commentsOnly) {
    // 只看评论区：不取字幕、不转写、不生成拼图。省请求，也断了"顺手当正文用"的可能。
    text = null; segments = []; source = null;
    warnings.push(`仅评论区模式：未取字幕/未转写/未看画面（评论 ${comments === Infinity ? "尽量翻到底" : `${comments} 条`}），结论只能标为观众说法`);
  }
  if (cached && !commentsOnly) log(`复用已验证身份的${source === "asr" ? "本地转写" : "字幕"}（${segments.length} 段）`);
  if (!cached && !forceAsr && !offline && !commentsOnly) {
    resolved = await resolveSubtitle(api, bvid, cid, view, { log,
      loadPlayer: (fresh) => context.player(fresh), loadSubtitle: (candidate, fresh) => context.subtitle(candidate, fresh) });
    if (resolved) {
      subCheck = { ...resolved.check, lexicalSuspicious: !!resolved.check.suspicious,
        suspicious: resolved.assessment.level === "suspect", assessment: resolved.assessment };
      const candidateText = `${view.title}\n${bvid}\n语言：${resolved.pick.lanDoc}\n\n` +
        resolved.lines.map((s) => `[${transcriptClock(s.from)}-${transcriptClock(s.to)}] ${s.text}`).join("\n") + "\n";
      if (resolved.assessment.level === "suspect") {
        await writeTextAtomic(join(dir, "transcript.subtitle-bad.txt"), candidateText);
      } else {
        text = candidateText; segments = resolved.lines; source = "subtitle"; subtitleLang = resolved.pick.lanDoc;
      }
    }
  }
  const needAsr = !commentsOnly && (forceAsr || asr && !text);
  if (needAsr && !offline) {
    if (view.duration > maxAsrMinutes * 60) warnings.push(`超过 ${maxAsrMinutes} 分钟，未做本地转写`);
    else {
      try {
        log("无可用文字或显式要求，执行本地转写…");
        const { file } = await io.ensureAudioFile(api, bvid, cid, { onProgress: onDownloadProgress });
        const stage = join(dir, "asr-run"); await mkdir(stage, { recursive: true });
        const wav = join(stage, "audio16k.wav");
        // Bound the audio from the start; do not wait for an already doubled WAV.
        await io.extractAudio(file, wav, { duration: view.duration });
        const out = await io.transcribe(wav, { bvid, model: asrModel, duration: view.duration, outDir: stage });
        const usable = out.segments || parseTranscript(await readFile(out.transcript, "utf8"));
        if (!usable.length) throw new Error("ASR 无可用文本");
        segments = usable; source = "asr"; subtitleLang = "本地转写";
        asrDiscardedCount = out.discardedCount || 0;
        text = `# 本地转写（whisper.cpp ${modelKey.split("|")[0]}）\nBV: ${bvid}\n\n` +
          segments.map((s) => `[${transcriptClock(s.from)}-${transcriptClock(s.to)}] ${s.text}`).join("\n") + "\n";
        // 证伪：文本重复 + 音频活跃度两路证据（whisper.cpp 没有 no_speech_prob，只能靠这两路）
        const activity = await analyzeAudioActivity(wav).catch(() => null);
        asrEvidence = assessAsrEvidence({ segments, duration: view.duration, activity });
        for (const file of ["asr.json", "asr.filtered.json"]) await copyFile(join(stage, file), join(dir, file)).catch(() => {});
        if (resolved?.assessment.level === "suspect") warnings.push("原字幕时间范围/结构异常，已改用本地转写");
      } catch (err) { stopOnAccountError(err); warnings.push(`本地转写失败：${err.message}`); }
    }
  }
  const asrHint = describeAsrEvidence(asrEvidence);
  if (asrHint) warnings.push(asrHint);
  if (text && source === "subtitle" && !subCheck?.assessment) {
    const assessment = assessSubtitle(segments, { duration: view.duration, lexical: subCheck || {}, playerSource: "cached" });
    subCheck = { ...subCheck, lexicalSuspicious: !!subCheck?.suspicious, suspicious: assessment.level === "suspect", assessment };
  }
  if (text) {
    if (!cached || cached.legacy) await saveTranscriptCache(dir, identity, { text, source,
      modelKey: source === "asr" ? modelKey : null, language: subtitleLang, subtitleCheck: subCheck, discardedCount: asrDiscardedCount,
      asrEvidence: source === "asr" ? asrEvidence : null });
  } else warnings.push(offline ? "离线无匹配转写缓存，未联网或执行 ASR" : "无可用文字；可显式 --asr 或检查隔离字幕");
  const assessment = subCheck?.assessment;
  if (source === "subtitle" && (assessment?.level === "review" || !assessment && subCheck?.suspicious)) {
    warnings.push("字幕待人工复核：标题/简介重合度或语速不足以确认来源；不会仅因此自动跑 ASR");
  }
  if (asrDiscardedCount) warnings.push(`ASR 已过滤 ${asrDiscardedCount} 个可疑段`);
  const chars = segments.reduce((n, s) => n + s.text.length, 0);
  const charsPerSec = chars && view.duration ? +(chars / view.duration).toFixed(2) : null;
  if (charsPerSec && (charsPerSec < 1.5 || charsPerSec > 9)) warnings.push(`文本密度 ${charsPerSec} 字/秒，请复核（不自动判错轨）`);
  const audience = await collectAudience(context, oldPacket,
    { danmaku, comments, commentsMode, commentMaxPages: maxCommentPages, log, warnings });
  const found = await findSheets(dir, { duration: view.duration, subtitles: segments });
  warnings.push(...(found.warnings || []));
  if (found.degraded) warnings.push(`视觉切点标记 ${found.degraded}，仅作回读参考`);
  const fav = favs?.videos?.find((v) => v.bvid === bvid);
  const packet = { bvid, generatedAt: new Date().toISOString(), multiPart: !!view.multiPart, selectedPage: 1,
    pageCount: view.pageCount || 1, view: Object.fromEntries([
      "title", "aid", "cid", "duration", "totalDuration", "multiPart", "page", "part", "pageCount", "pubdate", "desc", "pic", "owner", "stat", "tname",
      "argue", "fans", "upSign"
    ].map((key) => [key, view[key]])),
    fav: fav ? { folderTitle: fav.folders?.[0]?.title, favTime: fav.favTime, up: fav.up } : oldPacket?.fav || null,
    writing: noteBudget(view.duration, { depth }),
    evidence: { basis: commentsOnly ? "comments_only" : text ? "transcript" : "metadata",
      commentsRequested: comments === Infinity ? "all" : comments, commentsMode, watched: false, visualChecked: false },
    workflow: { stage: "prepared", cache: { ...context.store.stats, transcriptReused: !!cached },
      outlineRequired: false, visualPolicy: "on_demand", next: text ? "read_then_save_outline" : "review_missing_text" },
    materials: { transcript: text ? join(dir, "transcript.txt") : null, subtitleLang, subtitleCount: segments.length,
      asr: source === "asr", asrDiscardedCount, charsPerSec, warnings, subtitleCheck: subCheck,
      asrEvidence: source === "asr" ? asrEvidence : null,
      ...audience.materials, sheets: found.sheets, sheetsDir: found.dir,
      sheetsDegraded: found.degraded || null, sheetsMedianShot: found.medianShot || null,
    }, peaks: audience.peaks };
  Object.assign(packet.materials, await readingArtifacts(packet, dir));
  if (packet.materials.outline) packet.workflow.next = "reuse_outline_then_check_references";
  await writeJsonAtomic(join(dir, "packet.json"), packet);
  return packet;
}
