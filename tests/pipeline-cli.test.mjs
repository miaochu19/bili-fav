import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { ROOT } from "../lib/paths.mjs";
import { run } from "../lib/frames.mjs";
import { materialStore } from "../lib/material-cache.mjs";

test("CLI pipeline: offline prepare → outline → excerpt → free-prose write/strict verify", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bili-pipeline-cli-"));
  t.after(async () => { if (!resolve(dir).startsWith(resolve(tmpdir()) + sep)) throw Error("Invalid fixture"); await rm(dir, { recursive: true, force: true }); });
  await cp(join(ROOT, "lib"), join(dir, "lib"), { recursive: true });
  await cp(join(ROOT, "cli"), join(dir, "cli"), { recursive: true });
  const bvid = "BVtest000001", cache = join(dir, "data/cache", bvid);
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, "transcript.txt"), `标题\n${bvid}\n语言：中文\n\n[0:00-0:20] 第一部分的原文。\n[0:30-0:50] 第二部分的原文。\n[1:00-1:20] 第三部分的原文。\n`);
  await writeFile(join(cache, "packet.json"), JSON.stringify({ bvid, view: { title: "自由体测试", aid: 1, cid: 10, duration: 120 },
    materials: { transcript: join(cache, "transcript.txt"), subtitleLang: "中文", asr: false, sheets: [] } }));
  const env = { ...process.env, BILI_FAV_HOME: dir };
  const execute = (args) => run(process.execPath, [join(dir, "cli/note.mjs"), ...args], { cwd: dir, env });
  const store = materialStore(cache);
  await store.get("danmaku", { bvid, cid: 10, duration: 120 }, async () => ({ total: 7, peaks: [{ sec: 30, n: 7 }] }));
  await store.get("comments3", { bvid, aid: 1, ps: 20, mode: "all" },
    async () => ({ exhausted: true, list: [{ rpid: "1", text: "测试评论" }] }));
  const prepared = await execute(["prepare", bvid, "--offline"]);
  assert.match(prepared.stdout, /弹幕.*已获取，7 条/);
  let packet = JSON.parse(await readFile(join(cache, "packet.json"), "utf8"));
  assert.ok(packet.workflow.cache.transcriptReused);
  await execute(["pack", bvid, "--offline"]);
  const aliased = JSON.parse(await readFile(join(cache, "packet.json"), "utf8"));
  assert.deepEqual(aliased.materials.danmakuInfo, packet.materials.danmakuInfo);
  assert.deepEqual(aliased.materials.commentsInfo, packet.materials.commentsInfo);
  assert.deepEqual(aliased.peaks, packet.peaks);
  const help = (await execute(["help"])).stdout;
  assert.match(help, /兼容别名/); assert.match(help, /--no-danmaku/); assert.match(help, /--comments 0/);
  const draft = { version: 1, bvid, transcriptSha256: packet.materials.transcriptSha256, summary: "概述", chapters: [
    { title: "主题", from: 0, to: 120, points: [{ text: "记录第一部分", segmentIds: ["L1"], quote: "第一部分的原文。" }] },
  ] };
  const draftFile = join(dir, "outline-draft.json");
  for (const encoding of ["utf8", "utf16le"]) {
    await writeFile(draftFile, "\uFEFF" + JSON.stringify(draft), encoding);
    await execute(["outline", bvid, "--from", draftFile]);
  }
  const validOutline = await readFile(join(cache, "outline.json"), "utf8");
  const cases = [
    ['{"secret":"DO_NOT_ECHO",}', /JSON 文件格式无效/],
    [JSON.stringify({ ...draft, transcriptSha256: "bad" }), /指纹不一致.*当前模板/],
    [JSON.stringify({ ...draft, chapters: [{ ...draft.chapters[0], points: [{ text: "伪造", segmentIds: ["L1"], quote: "不存在的话" }] }] }), /并非.*L1.*excerpt/],
    [JSON.stringify({ ...draft, chapters: [{ ...draft.chapters[0], points: [{ text: "错段", segmentIds: ["L999"] }] }] }), /不存在.*L999/],
  ];
  for (const [body, expected] of cases) {
    await writeFile(draftFile, body);
    await assert.rejects(execute(["outline", bvid, "--from", draftFile]), (err) => {
      assert.equal(err.code, 1); assert.match(err.stderr, expected);
      assert.equal(err.stderr.trim().split(/\r?\n/).length, 1);
      assert.doesNotMatch(err.stderr, /\n\s+at |DO_NOT_ECHO/); return true;
    });
    assert.equal(await readFile(join(cache, "outline.json"), "utf8"), validOutline);
  }
  await assert.rejects(execute(["outline", bvid, "--from", draftFile, "--debug"]), (err) => {
    assert.match(err.stderr, /\n\s+at /); return true;
  });
  const excerpt = JSON.parse((await execute(["excerpt", bvid, "--ids", "L2"])).stdout);
  assert.equal(excerpt.segments[0].text, "第二部分的原文。");
  const body = "这是自然段，不需要固定模板。".repeat(20) + "第一处（0:01），第二处（0:31），第三处（1:01）。";
  const bodyFile = join(dir, "body.md"); await writeFile(bodyFile, body);
  await execute(["write", bvid, "--body", bodyFile]);
  const verified = await execute(["verify", bvid, "--strict"]);
  assert.match(verified.stdout, /通过/); assert.doesNotMatch(verified.stdout, /缺 rating|缺 tags|小标题|金句/);
  const notes = JSON.parse(await readFile(join(dir, "data/notes.json"), "utf8"));
  const note = await readFile(join(dir, "vault", notes[bvid].path), "utf8");
  assert.match(note, /summary_depth: detailed/); assert.match(note, /visual_coverage: text_only/);
  await writeFile(bodyFile, "无时间引用的正文。".repeat(25));
  await execute(["write", bvid, "--body", bodyFile]);
  await assert.rejects(execute(["verify", bvid, "--strict"]), /退出码/);
  const now = Math.floor(Date.now() / 1000);
  await writeFile(join(dir, "data/favs.json"), JSON.stringify({ videos: [
    { bvid: "BVtest000002", title: "最近 AI", duration: 600, favTime: now - 60 },
    { bvid: "BVtest000003", title: "旧 AI", duration: 600, favTime: now - 10 * 86400 },
    { bvid: "BVtest000004", title: "最近游戏", duration: 600, favTime: now - 60 },
  ] }));
  await writeFile(join(dir, "data/topics.json"), JSON.stringify({ assign: {
    BVtest000002: "AI/大模型", BVtest000003: "AI/大模型", BVtest000004: "游戏",
  } }));
  const planned = JSON.parse((await execute(["plan", "--topic", "AI/大模型", "--recent-days", "2", "--min-minutes", "3", "--max-minutes", "30", "--json"])).stdout);
  assert.deepEqual(planned.selected.map((v) => v.bvid), ["BVtest000002"]);
});
