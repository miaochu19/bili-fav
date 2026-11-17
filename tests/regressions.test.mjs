import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { downloadStream, firstPartView } from "../lib/media.mjs";
import { filterSuspectSegments, parseTranscript, alignSheets, transcriptClock } from "../lib/transcript.mjs";
import { whisperSegments } from "../lib/asr.mjs";
import { bodyChars, noteBudget, citedTimestamps } from "../lib/quality.mjs";
import { knownInFolder, mediaKey, mergeFolder } from "../lib/favorites.mjs";
import { BiliApi } from "../lib/api.mjs";
import { cleanState } from "../lib/state.mjs";
import { planCells, hsvDifference, hsvFrame } from "../lib/frames.mjs";
import { archiveCover } from "../lib/note.mjs";
import { validateModelAssignments } from "../lib/topics.mjs";

async function fixture(t, handler) {
  const dir = await mkdtemp(join(tmpdir(), "bili-fav-test-"));
  const server = createServer(handler);
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
    if (!resolve(dir).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unexpected test directory");
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, url: `http://127.0.0.1:${server.address().port}` };
}

const payload = Buffer.from("one copy only: 0123456789");
for (const scenario of ["fresh-200", "ignore-range-200", "resume-206", "restart-416"]) {
  test(`download: ${scenario} produces exactly one copy`, async (t) => {
    const ranges = [];
    const { dir, url } = await fixture(t, (req, res) => {
      ranges.push(req.headers.range);
      if (scenario === "restart-416" && req.headers.range) { res.writeHead(416); res.end(); }
      else if (scenario === "resume-206") {
        res.writeHead(206, { "Content-Range": `bytes 5-${payload.length - 1}/${payload.length}`, "Content-Length": payload.length - 5 });
        res.end(payload.subarray(5));
      } else { res.writeHead(200, { "Content-Length": payload.length }); res.end(payload); }
    });
    const file = join(dir, "download.bin");
    if (scenario !== "fresh-200") await writeFile(file, scenario === "restart-416" ? payload : payload.subarray(0, 5));
    const out = await downloadStream(url, file);
    assert.deepEqual(await readFile(file), payload);
    assert.equal(out.bytes, payload.length);
    if (scenario === "restart-416") assert.deepEqual(ranges, [`bytes=${payload.length}-`, undefined]);
  });
}

test("download: incorrect Content-Range does not corrupt the partial file", async (t) => {
  const { dir, url } = await fixture(t, (_, res) => { res.writeHead(206, { "Content-Range": "bytes 0-3/4" }); res.end("abcd"); });
  const file = join(dir, "partial");
  await writeFile(file, "keep");
  await assert.rejects(downloadStream(url, file), /Content-Range/);
  assert.equal(await readFile(file, "utf8"), "keep");
});

test("download: failed restart after 416 preserves the existing file", async (t) => {
  const { dir, url } = await fixture(t, (req, res) => { res.writeHead(req.headers.range ? 416 : 500); res.end(); });
  const file = join(dir, "complete");
  await writeFile(file, payload);
  await assert.rejects(downloadStream(url, file), /500/);
  assert.deepEqual(await readFile(file), payload);
});

test("ASR filters punctuation, sparse and invalid segments, preserving real speech", () => {
  const result = filterSuspectSegments([
    { from: 0, to: 10, text: "……！？" }, { from: 10, to: 25, text: "谢谢" },
    { from: 25, to: 29, text: "真实而且清晰的一段口播" }, { from: 31, to: 30, text: "倒序" },
    { from: 29, to: 40, text: "这段很长但是会被视频时长截断" },
  ], { duration: 30 });
  assert.equal(result.discardedCount, 3);
  assert.equal(result.segments.length, 2);
  assert.equal(result.segments.at(-1).to, 30);
});

test("Whisper millisecond offsets and decimal clocks retain precision", () => {
  assert.deepEqual(whisperSegments({ transcription: [{ offsets: { from: 1234, to: 2345 }, text: "一句话" }] }),
    [{ from: 1.234, to: 2.345, text: "一句话" }]);
  assert.equal(transcriptClock(1.234), "0:01.234");
  assert.equal(parseTranscript("[0:01.234-0:02.345] 一句话")[0].to, 2.345);
});

test("P1 metadata uses its own duration while retaining the collection total", () => {
  const v = firstPartView({ duration: 9000, cid: 1 }, [{ cid: 22, duration: 30, part: "第一讲" }, { cid: 23, duration: 8970 }]);
  assert.equal(v.cid, 22); assert.equal(v.duration, 30); assert.equal(v.totalDuration, 9000); assert.equal(v.multiPart, true);
  assert.throws(() => firstPartView({ duration: 9000 }, [{}, {}]), /第一 P 时长/);
});

test("each cell receives overlapping subtitles, including a line across a boundary", () => {
  const sheets = alignSheets([{ cells: [{ from: 60, to: 65 }, { from: 65, to: 70 }] }],
    [{ from: 61, to: 66, text: "跨格" }, { from: 65, to: 67, text: "第二格" }, { from: 70, to: 71, text: "窗外" }]);
  assert.deepEqual(sheets[0].cells.map((c) => c.subtitles.map((s) => s.text)), [["跨格"], ["跨格", "第二格"]]);
});

test("HSV detects same-brightness hue changes and cell plans cover a nonzero range", () => {
  assert.ok(hsvDifference(hsvFrame(Buffer.from([255, 0, 0])), hsvFrame(Buffer.from([0, 255, 0]))) > 0.12);
  const cells = planCells({ from: 60, to: 90, count: 12, cuts: [{ at: 64 }, { at: 65 }, { at: 66 }] });
  assert.equal(cells[0].from, 60); assert.equal(cells.at(-1).to, 90);
  assert.ok(cells.every((c) => c.from < c.at && c.at < c.to));
  assert.ok(cells.filter((c) => c.at < 70).length > 4);
});

test("note verification accepts explicit timestamps and ignores ratios, scores and frontmatter", () => {
  const values = citedTimestamps("---\r\nsummarized_at: 2026-10-28T09:48:06Z\r\n---\r\n比例 1:30 比分 12:34 **01:20** [02:10] 03:00–04:00 —— 00:12:33");
  assert.deepEqual(values, [80, 130, 180, 240, 753]);
  assert.equal(noteBudget(600).maxChars, 900);
  assert.equal(bodyChars("正文\n## 原始素材\n超长路径"), 2);
});

test("incremental membership is per folder and full merge preserves unscanned data", () => {
  const previous = [{ bvid: "BVfirst", folders: [{ id: 1 }] }, { bvid: "BVother", folders: [{ id: 2 }] }];
  const known = knownInFolder(previous, 1);
  assert.equal(known.has("BVother"), false);
  assert.equal(known.has("BVfirst"), true);
  const map = new Map(previous.map((v) => [mediaKey(v), v]));
  mergeFolder(map, [{ bvid: "BVnew", id: 9, title: "新的", duration: 10 }], { id: 1, title: "收藏夹" }, { complete: true });
  assert.equal(map.has("BVfirst"), false); assert.equal(map.has("BVother"), true); assert.equal(map.has("BVnew"), true);
});

test("favAll collects the boundary page before stopping; pagination errors propagate", async () => {
  const api = new BiliApi();
  const pages = [{ medias: [{ bvid: "new" }], hasMore: true }, { medias: [{ bvid: "known" }], hasMore: true }];
  api.favPage = async (_, page) => pages[page - 1];
  const out = await api.favAll(1, { shouldStop: (p) => p.medias.every((m) => m.bvid === "known") });
  assert.equal(out.medias.length, 2);
  await assert.rejects(api.favAll(1, { maxPages: 1 }), /上限/);
});

test("state cleanup keeps real work and repairs written status after repack", () => {
  const out = cleanState({ test: {}, real: { status: "packed" }, pending: { status: "packed" } },
    { favs: { videos: [{ bvid: "pending" }] }, notes: { real: { path: "note.md" } } });
  assert.deepEqual(out.removed, ["test"]); assert.equal(out.state.real.status, "written"); assert.ok(out.state.pending);
});

test("cover archive is local and has exact downloaded bytes", async (t) => {
  const { dir, url } = await fixture(t, (_, res) => { res.writeHead(200, { "Content-Type": "image/jpeg" }); res.end(Buffer.from([255, 216, 255, 217])); });
  const path = await archiveCover({ bvid: "BVcover", view: { pic: url } }, { vault: dir });
  assert.equal(path, "90-素材/BVcover/cover.jpg");
  assert.deepEqual(await readFile(join(dir, path)), Buffer.from([255, 216, 255, 217]));
});

test("model classification rejects unknown BV ids and vocabulary before import", () => {
  const videos = [{ bvid: "BVknown" }], rules = [{ name: "AI/大模型" }];
  assert.deepEqual(validateModelAssignments({ assign: { BVknown: "AI/大模型" } }, videos, rules), { BVknown: "AI/大模型" });
  assert.throws(() => validateModelAssignments({ assign: { BVmissing: "AI/大模型" } }, videos, rules), /无效分类/);
  assert.throws(() => validateModelAssignments({ assign: { BVknown: "随便发明" } }, videos, rules), /无效分类/);
  assert.throws(() => validateModelAssignments({ assign: [] }, videos, rules), /格式/);
});
