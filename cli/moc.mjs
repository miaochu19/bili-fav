#!/usr/bin/env node
// 主题页：把主题地图变成可浏览的 MOC（不下载视频、不消耗转写）
import { join } from "node:path";

import { FILES, DATA, VAULT, ensureDirs, rel } from "../lib/paths.mjs";
import { readJson, writeTextAtomic } from "../lib/fsx.mjs";
import { loadNotes, slugify } from "../lib/note.mjs";
import { fmtClock } from "../lib/media.mjs";

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c("2"), bold = c("1"), green = c("32");

const date = (unix) => (unix ? new Date(unix * 1000).toISOString().slice(0, 10) : "");
const LIMIT = 600; // 单页最多列多少条，避免 274KB 的巨型页面

async function main() {
  ensureDirs();
  const favs = await readJson(FILES.favs, null);
  if (!favs) {
    console.error("没有 data/favs.json，先 node cli/fav.mjs fetch --all");
    process.exit(1);
  }
  const topics = await readJson(join(DATA, "topics.json"), null);
  if (!topics?.assign) {
    console.error("没有 data/topics.json，先 node cli/topics.mjs build");
    process.exit(1);
  }
  const notes = await loadNotes();

  const groups = new Map();
  for (const v of favs.videos || []) {
    if (v.invalid) continue;
    const t = topics.assign[v.bvid] || "未分类";
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(v);
  }

  const index = [
    "---",
    "type: moc",
    "title: 主题索引",
    `updated: ${new Date().toISOString().slice(0, 10)}`,
    "---",
    "",
    "# 主题索引",
    "",
    "主题是按标题关键词粗分的，只用来导航；笔记的正式归属仍看收藏夹。",
    "",
    "| 主题 | 视频数 | 时长 | 已整理 |",
    "| --- | --- | --- | --- |",
  ];

  let written = 0;
  for (const [name, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    const hours = list.reduce((s, v) => s + (v.duration || 0), 0) / 3600;
    const done = list.filter((v) => notes[v.bvid]).length;
    const safe = slugify(name, 40);
    const pageRel = `10-主题/${safe}.md`;
    const sorted = list.slice().sort((a, b) => (b.favTime || 0) - (a.favTime || 0));
    const pageCount = Math.ceil(sorted.length / LIMIT);
    const pageName = (n) => n === 0 ? safe : `${safe}.part${String(n + 1).padStart(3, "0")}`;
    for (let page = 0; page < pageCount; page++) {

    const body = [
      "---",
      "type: topic",
      `title: ${JSON.stringify(name)}`,
      `count: ${list.length}`,
      `hours: ${hours.toFixed(1)}`,
      `updated: ${new Date().toISOString().slice(0, 10)}`,
      "---",
      "",
      `# ${name}（第 ${page + 1}/${pageCount} 页）`,
      "",
      `> ${list.length} 个视频 · ${hours.toFixed(1)} 小时 · 已整理 ${done} / ${list.length}`,
      "",
      Array.from({ length: pageCount }, (_, n) => n === page ? `第 ${n + 1} 页` : `[[10-主题/${pageName(n)}|第 ${n + 1} 页]]`).join(" · "),
      "",
      "| 状态 | 标题 | UP | 时长 | 收藏 |",
      "| --- | --- | --- | --- | --- |",
    ];
    for (const v of sorted.slice(page * LIMIT, (page + 1) * LIMIT)) {
      const n = notes[v.bvid];
      const mark = n ? `[[${n.path.replace(/\.md$/, "")}\\|${v.title.replace(/\|/g, "\\|")}]]` : v.title.replace(/\|/g, "\\|");
      const box = n ? "[x]" : "[ ]";
      body.push(`| ${box} | ${mark} | ${v.up || ""} | ${fmtClock(v.duration)} | ${date(v.favTime)} |`);
    }
    body.push("");

    await writeTextAtomic(join(VAULT, `10-主题/${pageName(page)}.md`), body.join("\n"));
    written++;
    }
    index.push(`| [[10-主题/${safe}\\|${name}]] | ${list.length} | ${hours.toFixed(1)}h | ${done} |`);
  }

  await writeTextAtomic(join(VAULT, "00-索引", "主题.md"), index.join("\n") + "\n");

  console.log(`${green("✓")} ${written} 个主题页 → ${rel(join(VAULT, "10-主题"))}`);
  console.log(`${green("✓")} ${rel(join(VAULT, "00-索引", "主题.md"))}`);
  console.log(dim(`  每个主题页都是可勾选的清单，已整理的笔记会直接链过去\n`));
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
