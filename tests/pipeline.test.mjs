import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { buildPacket, findSheets } from "../lib/pack.mjs";
import { getComments, collectComments, rankComments } from "../lib/media.mjs";
import { openMaterials } from "../lib/materials.mjs";
import { materialStore, readTranscriptCache } from "../lib/material-cache.mjs";
import { assessSubtitle } from "../lib/subtitle-quality.mjs";
import { noteBudget, bodyMetrics, bodyChars, citationAudit, sheetBudget } from "../lib/quality.mjs";
import { transcriptDocument, saveOutline, readingArtifacts } from "../lib/outline.mjs";

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "bili-pipeline-"));
  t.after(async () => { if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error("Invalid test root"); await rm(root, { recursive: true, force: true }); });
  const bvid = "BVtest000001", calls = {}, state = { tracks: true, failAsr: false };
  const hit = (name) => { calls[name] = (calls[name] || 0) + 1; };
  const lines = [0, 30, 60, 90].map((from) => ({ from, to: from + 20, text: "今天从几个方面讨论这件事，并解释具体步骤和相应的限制。" }));
  const services = {
    getView: async () => { hit("view"); return { title: "一个有自主意识的插件", aid: 1, cid: 10, duration: 120, desc: "内容摘要" }; },
    getPages: async () => { hit("pages"); return [{ cid: 10, duration: 120, page: 1 }]; },
    getPlayer: async () => { hit("player"); return { source: "wbi", raw: { secret: "DO_NOT_STORE_RAW" }, subtitles: state.tracks ? [{ lan: "zh-CN", lanDoc: "中文", url: "https://example.invalid/sub.json" }] : [] }; },
    fetchSubtitle: async () => { hit("subtitle"); return lines; },
    getDanmakuPeaks: async () => { hit("danmaku"); return { total: 1, bucketSec: 30, peaks: [{ sec: 30, n: 1 }] }; },
    getComments: async () => { hit("comments"); return { list: [{ rpid: "1", text: "观众意见", like: 1 }], total: 1 }; },
    asrModelKey: async () => "ggml-test.bin|1|0|zh|ml30|filter1",
    ensureAudioFile: async () => { hit("audio"); return { file: "test-audio" }; },
    extractAudio: async (_, __, options) => { hit("extract"); assert.equal(options.duration, 120); },
    transcribe: async () => { hit("asr"); if (state.failAsr) throw Error("synthetic ASR failure"); return { segments: lines, discardedCount: 2 }; },
  };
  const api = { cookies: { DedeUserID: "test-user" } };
  const options = { cacheRoot: root, services, comments: 0, danmaku: false };
  return { root, bvid, dir: join(root, bvid), calls, state, services, api, options, lines };
}

test("pipeline: hook titles stay review-only; --asr does not transcribe usable subtitles", async (t) => {
  const f = await setup(t);
  const p = await buildPacket(f.api, f.bvid, { ...f.options, asr: true });
  assert.equal(p.materials.subtitleCheck.assessment.level, "review");
  assert.equal(p.materials.subtitleCheck.suspicious, false);
  assert.equal(p.materials.subtitleCheck.lexicalSuspicious, true);
  assert.equal(p.materials.asr, false); assert.equal(f.calls.asr || 0, 0);
  assert.equal(f.calls.player, 1); assert.equal(f.calls.subtitle, 1);
  assert.ok(p.materials.warnings.some((s) => s.includes("人工复核")));
  assert.ok((await readFile(p.materials.readingGuide, "utf8")).includes("机械阅读地图"));
  assert.ok(!(await readFile(join(f.dir, "material.player.json"), "utf8")).includes("DO_NOT_STORE_RAW"));
});

test("pipeline: probe then prepare shares metadata/player/danmaku/comments and later reuses text", async (t) => {
  const f = await setup(t), context = await openMaterials(f.api, f.bvid, f.options);
  await context.player(); await context.danmaku(); await context.comments();
  await buildPacket(f.api, f.bvid, { ...f.options, comments: 5, danmaku: true });
  const before = { ...f.calls };
  const p = await buildPacket(f.api, f.bvid, { ...f.options, asr: true, comments: 5, danmaku: true });
  assert.deepEqual(f.calls, before);
  assert.deepEqual(before, { view: 1, pages: 1, player: 1, danmaku: 1, comments: 1, subtitle: 1 });
  assert.equal(p.workflow.cache.transcriptReused, true);
  assert.equal(p.materials.commentsSource, "community_unverified");
});

test("audience: defaults acquire both signals; opting out retains them without service calls", async (t) => {
  const f = await setup(t);
  const defaults = { cacheRoot: f.root, services: f.services };
  const first = await buildPacket(f.api, f.bvid, defaults);
  assert.equal(f.calls.danmaku, 1); assert.equal(f.calls.comments, 1);
  assert.equal(first.materials.danmakuInfo.status, "available");
  const before = { ...f.calls };
  const second = await buildPacket(f.api, f.bvid, f.options);
  assert.deepEqual(f.calls, before);
  assert.equal(second.materials.danmakuTotal, 1); assert.deepEqual(second.peaks, first.peaks);
  assert.deepEqual(second.materials.comments, first.materials.comments);
  assert.equal(second.materials.danmakuInfo.requested, false); assert.equal(second.materials.danmakuInfo.retained, true);
  const guide = await readFile(second.materials.readingGuide, "utf8");
  assert.match(guide, /弹幕：保留已有材料/); assert.match(guide, /--no-danmaku/); assert.match(guide, /评论：保留已有材料/);
});

test("audience: skipped, fetched-empty, and failed states are distinct in packet and reading guide", async (t) => {
  const f = await setup(t);
  const skipped = await buildPacket(f.api, f.bvid, f.options);
  assert.equal(skipped.materials.danmakuTotal, null); assert.equal(skipped.materials.danmakuInfo.status, "not_requested");
  assert.match(await readFile(skipped.materials.readingGuide, "utf8"), /弹幕：本次未请求/);
  f.services.getDanmakuPeaks = async () => { throw Error("fixture unavailable"); };
  f.services.getComments = async () => { throw Error("fixture unavailable"); };
  const failed = await buildPacket(f.api, f.bvid, { ...f.options, danmaku: true, comments: 5 });
  assert.equal(failed.materials.danmakuTotal, null); assert.equal(failed.materials.danmakuInfo.status, "unavailable");
  assert.match(await readFile(failed.materials.readingGuide, "utf8"), /弹幕：获取失败/);
  f.services.getDanmakuPeaks = async () => ({ total: 0, peaks: [] });
  f.services.getComments = async () => ({ list: [], total: 0 });
  const empty = await buildPacket(f.api, f.bvid, { ...f.options, danmaku: true, comments: 5 });
  assert.equal(empty.materials.danmakuTotal, 0); assert.equal(empty.materials.danmakuInfo.status, "empty");
  assert.equal(empty.materials.commentsInfo.status, "empty");
  assert.match(await readFile(empty.materials.readingGuide, "utf8"), /弹幕：已获取，0 条/);
});

test("audience: failed refresh retains known signals, but risk control still aborts", async (t) => {
  const f = await setup(t), opts = { ...f.options, danmaku: true, comments: 5 };
  const first = await buildPacket(f.api, f.bvid, opts);
  f.services.getDanmakuPeaks = async () => { throw Error("fixture unavailable"); };
  f.services.getComments = async () => { throw Error("fixture unavailable"); };
  const failed = await buildPacket(f.api, f.bvid, { ...opts, refresh: true });
  assert.equal(failed.materials.danmakuTotal, first.materials.danmakuTotal);
  assert.deepEqual(failed.peaks, first.peaks); assert.deepEqual(failed.materials.comments, first.materials.comments);
  assert.equal(failed.materials.danmakuInfo.retained, true); assert.match(failed.materials.danmakuInfo.error, /unavailable/);
  const before = await readFile(join(f.dir, "packet.json"), "utf8");
  f.services.getDanmakuPeaks = async () => { throw Object.assign(Error("risk"), { name: "RiskControlError" }); };
  await assert.rejects(buildPacket(f.api, f.bvid, { ...opts, refresh: true }), { name: "RiskControlError" });
  assert.equal(await readFile(join(f.dir, "packet.json"), "utf8"), before);
});

test("audience: probe cache is retained even when this prepare does not request optional signals", async (t) => {
  const f = await setup(t), context = await openMaterials(f.api, f.bvid, f.options);
  await context.danmaku(); await context.comments();
  const p = await buildPacket(f.api, f.bvid, f.options);
  assert.equal(f.calls.danmaku, 1); assert.equal(f.calls.comments, 1);
  assert.equal(p.materials.danmakuTotal, 1); assert.equal(p.materials.comments.length, 1);
  assert.equal(p.materials.danmakuInfo.origin, "cache"); assert.equal(p.materials.danmakuInfo.retained, true);
});

test("audience: legacy peak file repairs erased zero fields, bound to matching BV/cid/duration", async (t) => {
  const f = await setup(t);
  const old = await buildPacket(f.api, f.bvid, f.options);
  delete old.materials.danmakuInfo; old.materials.danmakuTotal = 0;
  await writeFile(join(f.dir, "packet.json"), JSON.stringify(old));
  await writeFile(join(f.dir, "danmaku_peaks.txt"), `BV: ${f.bvid}\n共 7 条弹幕，桶 30s\n\n0:00\t2\n0:30\t2\n1:00\t1\n1:30\t2\n`);
  const before = { ...f.calls };
  const repaired = await buildPacket(null, f.bvid, { ...f.options, offline: true });
  assert.deepEqual(f.calls, before); assert.equal(repaired.materials.danmakuTotal, 7); assert.equal(repaired.peaks.length, 4);
  assert.equal(repaired.materials.danmakuInfo.origin, "legacy_file"); assert.equal(repaired.materials.danmakuInfo.fetchedAt, null);
  old.view.cid = 999;
  await writeFile(join(f.dir, "packet.json"), JSON.stringify(old));
  const mismatch = await buildPacket(f.api, f.bvid, f.options);
  assert.equal(mismatch.materials.danmakuTotal, null); assert.equal(mismatch.materials.danmakuInfo.status, "not_requested");
});

test("pipeline: ASR cache is checked before any player/download/transcription work", async (t) => {
  const f = await setup(t); f.state.tracks = false;
  const first = await buildPacket(f.api, f.bvid, { ...f.options, asr: true });
  assert.equal(first.materials.asr, true); assert.equal(f.calls.asr, 1);
  const before = { ...f.calls };
  const second = await buildPacket(f.api, f.bvid, { ...f.options, asr: true });
  assert.deepEqual(f.calls, before); assert.equal(second.workflow.cache.transcriptReused, true);
  assert.equal(await readTranscriptCache(f.dir, { bvid: f.bvid, cid: 20, duration: 120 }, { modelKey: await f.services.asrModelKey() }), null);
  assert.equal(await readTranscriptCache(f.dir, { bvid: f.bvid, cid: 10, duration: 120 }, { modelKey: "different-model" }), null);
});

test("pipeline: failed forced ASR keeps previous text/metadata; manual edits are not overwritten", async (t) => {
  const f = await setup(t);
  const p = await buildPacket(f.api, f.bvid, f.options);
  const old = await readFile(p.materials.transcript, "utf8"), meta = await readFile(join(f.dir, "transcript.meta.json"), "utf8");
  f.state.failAsr = true;
  const failed = await buildPacket(f.api, f.bvid, { ...f.options, forceAsr: true });
  assert.equal(await readFile(p.materials.transcript, "utf8"), old);
  assert.equal(await readFile(join(f.dir, "transcript.meta.json"), "utf8"), meta);
  assert.ok(failed.materials.warnings.some((s) => s.includes("synthetic ASR failure")));
  await writeFile(p.materials.transcript, old + "人工修正\n");
  await assert.rejects(buildPacket(f.api, f.bvid, f.options), /指纹不符/);
  assert.ok((await readFile(p.materials.transcript, "utf8")).endsWith("人工修正\n"));
});

test("pipeline: account/risk failures propagate and are never retried as alternate subtitles", async (t) => {
  const f = await setup(t);
  f.services.getPlayer = async () => { f.calls.risk = (f.calls.risk || 0) + 1; throw Object.assign(Error("risk"), { name: "RiskControlError" }); };
  await assert.rejects(buildPacket(f.api, f.bvid, f.options), { name: "RiskControlError" });
  assert.equal(f.calls.risk, 1);
});

test("pipeline: offline prepare reuses context/text without invoking a network service", async (t) => {
  const f = await setup(t);
  await buildPacket(f.api, f.bvid, f.options);
  const before = { ...f.calls };
  const p = await buildPacket(null, f.bvid, { ...f.options, offline: true });
  assert.deepEqual(f.calls, before); assert.equal(p.workflow.cache.transcriptReused, true);
  await assert.rejects(buildPacket(null, f.bvid, { ...f.options, offline: true, forceAsr: true }), /offline/);
});

test("material cache expires, refreshes, scopes accounts, and shares an in-flight load", async (t) => {
  const f = await setup(t); let now = 0, loads = 0;
  const cache = materialStore(f.dir, { scope: "a", now: () => now });
  const load = async () => { loads++; return "value"; };
  await Promise.all([cache.get("fixture", { cid: 1 }, load, { ttl: 10 }), cache.get("fixture", { cid: 1 }, load, { ttl: 10 })]);
  assert.equal(loads, 1);
  now = 11; await cache.get("fixture", { cid: 1 }, load, { ttl: 10 }); assert.equal(loads, 2);
  await materialStore(f.dir, { scope: "b" }).get("fixture", { cid: 1 }, load); assert.equal(loads, 3);
});

test("subtitle decisions separate topic uncertainty from invalid part timing", () => {
  const lines = [{ from: 0, to: 10, text: "内容正常但是标题没有被念到" }];
  assert.equal(assessSubtitle(lines, { duration: 100, lexical: { suspicious: true } }).asrRecommended, false);
  assert.equal(assessSubtitle([{ from: 0, to: 900, text: "超界" }], { duration: 100 }).level, "suspect");
  assert.equal(assessSubtitle([], { duration: 100 }).level, "missing");
});

test("outline references survive reuse and reject stale fingerprints/invented quotes", async (t) => {
  const f = await setup(t), p = await buildPacket(f.api, f.bvid, f.options), doc = await transcriptDocument(p);
  const draft = { version: 1, bvid: f.bvid, transcriptSha256: doc.sha256, summary: "摘要", chapters: [
    { title: "主题", from: 0, to: 120, points: [{ text: "作者解释步骤", segmentIds: ["L1"], quote: f.lines[0].text }] },
  ] };
  await saveOutline(draft, p, f.dir);
  const repeat = await buildPacket(f.api, f.bvid, f.options);
  assert.ok(repeat.materials.outline); assert.equal(repeat.workflow.next, "reuse_outline_then_check_references");
  await assert.rejects(saveOutline({ ...draft, transcriptSha256: "stale" }, p, f.dir), /指纹不一致/);
  const bad = structuredClone(draft); bad.chapters[0].points[0].quote = "素材里没有这句";
  await assert.rejects(saveOutline(bad, p, f.dir), /并非/);
  const badId = structuredClone(draft); badId.chapters[0].points[0].segmentIds = ["L999"];
  await assert.rejects(saveOutline(badId, p, f.dir), /不存在/);
  await writeFile(p.materials.transcript, doc.text + "[1:55-1:58] 新内容\n");
  const stale = await readingArtifacts(p, f.dir);
  assert.equal(stale.outline, null);
  assert.ok((await readFile(stale.readingGuide, "utf8")).includes("旧提纲已过期"));
});

test("writing budgets keep medium videos, enforce shallow long videos and window image caps", () => {
  assert.equal(noteBudget(900).maxChars, 2000);
  assert.equal(noteBudget(900, { depth: "shallow" }).maxChars, 400);
  assert.equal(noteBudget(3600).maxChars, 400);
  assert.equal(noteBudget(3600, { depth: "detailed" }).maxChars, 2600);
  assert.throws(() => noteBudget(100, { depth: "unknown" }), /depth/);
  assert.deepEqual([180, 300, 301, 1800, 1801].map(sheetBudget), [4, 4, 8, 8, 12]);
});

test("body budget removes explicit references/markup while preserving ratios and data", () => {
  const text = "## 参数\n比例1:30，电池7500mAh（0:12）和[来源](https://example.invalid)";
  const stats = bodyMetrics(text);
  assert.equal(bodyChars(text), [..."参数比例1:30，电池7500mAh和来源"].length);
  assert.ok(stats.rawChars > stats.contentChars);
  assert.equal(bodyChars("`（21:56）`"), [..."（21:56）"].length);
  assert.equal(citationAudit("`（21:56）`", 10).errors.length, 0);
});

test("citation audit flags missing/distinct anchors and contextual naked overflow, not ratios", () => {
  assert.ok(citationAudit("自然段但没有引用", 664).warnings.some((s) => s.includes("没有可识别")));
  assert.ok(citationAudit("- 21:56 要点甲\n- 21:56 要点乙\n- 21:56 要点丙", 664).errors.length);
  assert.equal(citationAudit("比例21:56\n比例21:56\n比例21:56", 664).errors.length, 0);
  assert.ok(citationAudit("（0:10）（0:10）（0:10）", 664).warnings.length);
  assert.ok(citationAudit("（11:07）", 664).errors.length);
  assert.equal(citationAudit("只看画面", 120, { kind: "visual_only" }).warnings.length, 0);
});

test("comments-only mode skips subtitles/ASR, marks evidence basis and caps comment count", async (t) => {
  const f = await setup(t);
  const p = await buildPacket(f.api, f.bvid, { ...f.options, commentsOnly: true, comments: 30 });
  assert.equal(p.evidence.basis, "comments_only");
  assert.equal(p.evidence.watched, false);
  assert.equal(p.materials.transcript, null);
  assert.equal(f.calls.player || 0, 0, "不应取播放器信息");
  assert.equal(f.calls.subtitle || 0, 0, "不应下载字幕");
  assert.equal(f.calls.asr || 0, 0, "不应转写");
  assert.ok(p.materials.warnings.some((w) => w.includes("仅评论区模式")));
  await assert.rejects(buildPacket(f.api, f.bvid, { ...f.options, comments: 1001 }), /0–1000/);
  await assert.rejects(buildPacket(f.api, f.bvid, { ...f.options, commentsOnly: true, comments: 0 }), /至少需要/);
});

test("comments: page mapping marks pinned/UP/sub-replies and keeps both totals", async () => {
  const api = { request: async () => ({
    replies: [
      { rpid: 11, member: { mid: 9, uname: "UP主" }, content: { message: "UP 的普通评论" }, like: 3, ctime: 1700000000,
        replies: [{ rpid: 111, member: { mid: 9, uname: "UP主" }, content: { message: "UP 的楼中楼" }, like: 0 }] },
      { rpid: 12, member: { mid: 7, uname: "观众" }, content: { message: "普通观众" }, like: 1, ctime: 1700000001 },
    ],
    top: [],
    upper: { top: { rpid: 10, member: { mid: 9, uname: "UP主" }, content: { message: "UP 置顶" }, like: 0 } },
    page: { count: 2, acount: 3 },
  }) };
  const page = await getComments(api, 1, { upMid: 9, maxChars: 40 });
  assert.equal(page.total, 2); assert.equal(page.acount, 3);
  assert.deepEqual(page.list.map((c) => c.rpid), ["10", "11", "12"]);
  assert.equal(page.list[0].tag, "UP置顶"); assert.equal(page.list[0].isUp, true);
  assert.equal(page.list[1].isUp, true);
  assert.equal(page.list[1].replyPreview[0].isUp, true);
  assert.equal(page.list[2].isUp, false);
});

test("comments: deep collection paginates, dedupes, ranks pinned → UP → likes, and reports budget", async () => {
  const make = (from, n) => Array.from({ length: n }, (_, i) => ({ rpid: String(from + i), like: 100 - from - i }));
  const fetchPage = async ({ pn }) => ({ list: [make(0, 20), make(20, 20), make(40, 5)][pn - 1] || [], total: 45, acount: 60 });
  const wanted = await collectComments(fetchPage, { want: 30, ps: 20, mode: "hot", maxPages: 10 });
  assert.equal(wanted.list.length, 30);
  assert.equal(wanted.pages, 2, "取满 30 条就停，不多翻");
  assert.equal(wanted.exhausted, false);
  assert.equal(wanted.list[0].like, 100);

  const budget = await collectComments(fetchPage, { want: Infinity, ps: 20, mode: "hot", maxPages: 2 });
  assert.equal(budget.pages, 2); assert.equal(budget.truncated, true); assert.equal(budget.exhausted, false);
  assert.equal(budget.list.length, 40);

  // 热度翻页打转（整页重复）时按"到底"处理，不无限翻
  const stuck = await collectComments(async ({ pn }) => ({ list: make(0, 20), total: 500 }), { want: Infinity, mode: "hot", maxPages: 50 });
  assert.equal(stuck.pages, 3); assert.equal(stuck.exhausted, true); assert.equal(stuck.list.length, 20);

  const ranked = rankComments([
    { rpid: "like", like: 100 }, { rpid: "up", like: 0, isUp: true }, { rpid: "pin", like: 5, tag: "置顶" },
  ]);
  assert.deepEqual(ranked.map((c) => c.rpid), ["pin", "up", "like"]);
});

test("reading entry carries description and unverified comments, with or without transcript", async (t) => {
  const f = await setup(t), p = await buildPacket(f.api, f.bvid, { ...f.options, comments: 5 });
  p.view.desc = "仓库 github.com/example/x\n需要 Node ≥ 22.13";
  const withText = await readingArtifacts(p, f.dir), guide = await readFile(withText.readingGuide, "utf8");
  assert.ok(guide.includes("## 简介（作者自述，必读）"));
  assert.ok(guide.includes("github.com/example/x"));
  assert.ok(guide.includes("## 观众评论（未核实，只作观众信号）"));
  assert.ok(guide.includes("观众意见"));
  assert.ok(guide.includes("[赞 1]"));
  assert.equal(await readFile(withText.description, "utf8").then((s) => s.includes("Node ≥ 22.13")), true);
  // 评论全文另存一份：READING.md 只内联最该看的那几条，其余在这里
  assert.equal(p.materials.commentsFile, join(f.dir, "comments.md"));
  const dump = await readFile(p.materials.commentsFile, "utf8");
  assert.match(dump, /观众评论（未核实）/); assert.match(dump, /观众意见/);
  assert.ok(guide.indexOf("## 简介") < guide.indexOf("## 观众评论"));
  assert.ok(guide.indexOf("## 观众评论") < guide.indexOf("## 阅读与复用"));
  p.materials.transcript = null;
  const noText = await readingArtifacts(p, f.dir), bare = await readFile(noText.readingGuide, "utf8");
  assert.ok(bare.includes("## 简介（作者自述，必读）") && bare.includes("## 观众评论（未核实，只作观众信号）"));
  p.view.desc = "";
  const noDesc = await readFile((await readingArtifacts(p, f.dir)).readingGuide, "utf8");
  assert.ok(noDesc.includes("该视频没有简介"));
});

test("sheet lookup is read-only and diagnoses malformed manifests rather than guessing offsets", async (t) => {
  const f = await setup(t), dir = join(f.root, "sheets_5s_4x4_scene_60-65");
  const { mkdir } = await import("node:fs/promises"); await mkdir(dir);
  await writeFile(join(dir, "sheet_001.jpg"), "fixture"); await writeFile(join(dir, "INDEX.txt"), "keep exactly");
  await writeFile(join(dir, "sheets.json"), JSON.stringify({ version: 2, from: 60, to: 65, sheets: [] }));
  const empty = await findSheets(f.root); assert.equal(empty.sheets.length, 0);
  assert.equal(await readFile(join(dir, "INDEX.txt"), "utf8"), "keep exactly");
  await writeFile(join(dir, "sheets.json"), JSON.stringify({ version: 2, sheets: "bad" }));
  const invalid = await findSheets(f.root); assert.equal(invalid.sheets.length, 0); assert.ok(invalid.warnings.length);
  assert.equal(await readFile(join(dir, "INDEX.txt"), "utf8"), "keep exactly");
});
