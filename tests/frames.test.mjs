import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { DATA } from "../lib/paths.mjs";
import { run, FFMPEG, probeMedia, buildSheets, buildSubStrip, scanScenes } from "../lib/frames.mjs";
import { findSheets } from "../lib/pack.mjs";

test("ffmpeg: scene/uniform A-B, window offsets, cell metadata, substrip and reruns", { skip: !existsSync(FFMPEG) }, async (t) => {
  const parent = join(DATA, "tmp");
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, "frames-test-"));
  t.after(async () => {
    if (!resolve(dir).startsWith(resolve(parent) + sep)) throw new Error("Unexpected fixture path");
    await rm(dir, { recursive: true, force: true });
  });
  const video = join(dir, "cuts.mp4");
  const colors = ["red", "green", "blue", "white", "black", "yellow", "magenta", "cyan"];
  await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y",
    ...colors.flatMap((c) => ["-f", "lavfi", "-i", `color=c=${c}:s=160x90:r=10:d=1`]),
    "-filter_complex", colors.map((_, i) => `[${i}:v]`).join("") + `concat=n=${colors.length}:v=1:a=0[v]`,
    "-map", "[v]", "-c:v", "mpeg4", video]);
  const cuts = await scanScenes(video, { from: 1, to: 7 });
  assert.ok(cuts.length >= 4, `only ${cuts.length} cuts found`);
  const options = { from: 1, to: 7, grid: 2, cell: 160, step: 3, maxSheets: 2,
    subtitles: [{ from: 1.1, to: 2.1, text: "红绿切换" }] };
  const sceneDir = join(dir, "sheets_scene");
  const scene = await buildSheets(video, sceneDir, { ...options, mode: "scene" });
  const uniform = await buildSheets(video, join(dir, "sheets_uniform"), { ...options, mode: "uniform" });
  assert.ok(scene.flatMap((s) => s.cells).length > uniform.flatMap((s) => s.cells).length);
  assert.equal(scene[0].from, 1);
  assert.equal(scene.at(-1).to, 7);
  assert.ok(scene.flatMap((s) => s.cells).some((c) => c.subtitles.length));
  assert.ok(scene.flatMap((s) => s.cells).every((c) => c.at >= c.from && c.at < c.to));
  // Uniform window 1–7 gives its first representative at 2.5s: the blue shot.
  const pixel = join(dir, "first-cell.rgb");
  await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", uniform[0].file,
    "-vf", "crop=160:90:0:0,scale=1:1", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", pixel]);
  const rgb = await readFile(pixel);
  assert.ok(rgb[2] > rgb[0] + rgb[1], `wrong frame for absolute window: ${[...rgb]}`);
  const image = await probeMedia(scene[0].file);
  assert.equal(image.width, 320); assert.equal(image.height, 180);
  assert.match(await readFile(join(sceneDir, "INDEX.txt"), "utf8"), /红绿切换/);
  // Same output directory, fewer sheets: stale JPEGs must disappear.
  await buildSheets(video, sceneDir, { ...options, mode: "uniform", maxSheets: 1 });
  assert.equal((await readdir(sceneDir)).filter((f) => /^sheet_\d+\.jpg$/.test(f)).length, 1);
  const found = await findSheets(dir, { duration: 8 });
  assert.equal(found.sheets[0].from, 1);
  assert.equal(found.sheets.at(-1).to, 7);
  const strip = join(dir, "strip.jpg");
  await buildSubStrip(video, strip, { width: 160, crop: 0.2, from: 1, to: 7, maxFrames: 4, step: 1 });
  const stripImage = await probeMedia(strip);
  assert.equal(stripImage.width, 160); assert.equal(stripImage.height, 72);
  // A flat ffmpeg expression of >100 terms used to fail with a misleading ENOMEM.
  const many = await buildSheets(video, join(dir, "many"), { mode: "uniform", step: 0.05, grid: 4, cell: 80, maxSheets: 10 });
  assert.equal(many.flatMap((s) => s.cells).length, 160);
});

import { assessDegraded, spikeCuts, rateThreshold } from "../lib/frames.mjs";

test("assessDegraded: 匀速运镜判 motion，每帧一剪不判", () => {
  // 中位镜头 0.33s、一半的帧都在动、分数很平滑 → 运镜
  assert.equal(assessDegraded({ span: 10, cuts: 30, hotRatio: 0.5, scoreCv: 0.1, scoreMean: 0.2 }), "motion");
  // 同样密，但分数忽高忽低（每帧一剪）→ 是真剪辑，不标 degraded
  assert.equal(assessDegraded({ span: 10, cuts: 30, hotRatio: 0.5, scoreCv: 0.6, scoreMean: 0.3 }), null);
  // 镜头很长 → 不判
  assert.equal(assessDegraded({ span: 100, cuts: 5, hotRatio: 0.1, scoreCv: 0.2, scoreMean: 0.05 }), null);
});

test("spikeCuts 认本地突变，rateThreshold 不低于地板", () => {
  const stats = [
    { at: 0, score: 0.01 }, { at: 1, score: 0.01 }, { at: 2, score: 0.9 }, { at: 3, score: 0.01 }, { at: 4, score: 0.01 },
  ];
  const cuts = spikeCuts(stats, { minAbs: 0.1 });
  assert.equal(cuts.length, 1);
  assert.equal(cuts[0].at, 2);
  assert.ok(rateThreshold([0.01, 0.01, 0.9], { duration: 3 }) >= 12 / 255);
});
