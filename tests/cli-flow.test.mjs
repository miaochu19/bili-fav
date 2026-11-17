import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { ROOT } from "../lib/paths.mjs";
import { run } from "../lib/frames.mjs";

test("CLI: model import survives rebuild/show, MOC paginates all rows, long bodies do not write", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bili-fav-cli-"));
  t.after(async () => {
    if (!resolve(dir).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unexpected test path");
    await rm(dir, { recursive: true, force: true });
  });
  await cp(join(ROOT, "cli"), join(dir, "cli"), { recursive: true });
  await cp(join(ROOT, "lib"), join(dir, "lib"), { recursive: true });
  await mkdir(join(dir, "data"), { recursive: true });
  const videos = Array.from({ length: 601 }, (_, i) => ({ bvid: `BVtest${String(i).padStart(6, "0")}`, title: `没有分类词${i}`, duration: 60 }));
  const save = (file, data) => writeFile(join(dir, file), JSON.stringify(data), "utf8");
  await save("data/favs.json", { videos });
  await save("model.json", { assign: { [videos[0].bvid]: "AI/大模型" } });
  const env = { ...process.env, BILI_FAV_HOME: dir };
  const execute = (file, args = []) => run(process.execPath, [join(dir, "cli", file), ...args], { cwd: dir, env });
  await execute("topics.mjs", ["build", "--from-model", join(dir, "model.json")]);
  await execute("topics.mjs", ["build"]);
  const classified = JSON.parse(await readFile(join(dir, "data/topics.json"), "utf8"));
  assert.equal(classified.assign[videos[0].bvid], "AI/大模型");
  assert.match((await execute("topics.mjs", ["show", "AI/大模型"])).stdout, /BVtest000000/);
  // A controlled single topic ensures a real overflow over 600 members.
  await save("data/topics.json", { assign: Object.fromEntries(videos.map((v) => [v.bvid, "未分类"])) });
  await execute("moc.mjs");
  const pages = (await readdir(join(dir, "vault", "10-主题"))).filter((f) => f.endsWith(".md"));
  assert.equal(pages.length, 2);
  const contents = await Promise.all(pages.map((p) => readFile(join(dir, "vault", "10-主题", p), "utf8")));
  assert.equal(contents.reduce((n, s) => n + [...s.matchAll(/^\| \[ \] \|/gm)].length, 0), 601);
  assert.ok(contents.every((s) => s.includes("第 2 页")));
  const cache = join(dir, "data/cache", videos[0].bvid);
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, "packet.json"), JSON.stringify({ bvid: videos[0].bvid, view: { title: "标题", duration: 60 }, materials: {} }));
  await writeFile(join(dir, "long.md"), "字".repeat(1000));
  await assert.rejects(execute("note.mjs", ["write", videos[0].bvid, "--body", join(dir, "long.md")]), /超过上限/);
  assert.equal(existsSync(join(dir, "data/notes.json")), false);
});
