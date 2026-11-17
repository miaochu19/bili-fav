#!/usr/bin/env node
// 全量目录：不下载视频，只把 favs.json 变成可检索的索引
import { FILES, VAULT, ensureDirs, rel } from "../lib/paths.mjs";
import { readJson, writeTextAtomic } from "../lib/fsx.mjs";
import { fmtClock } from "../lib/media.mjs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const cmd = argv[0] || "help";
const rest = argv.slice(1);
function flag(name, fallback) {
  const i = rest.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = rest[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c("2"), bold = c("1"), green = c("32"), yellow = c("33"), red = c("31");

const date = (unix) => (unix ? new Date(unix * 1000).toISOString().slice(0, 10) : "");

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function load() {
  const data = await readJson(FILES.favs, null);
  if (!data) {
    console.error(red("没有 data/favs.json，先 node cli/fav.mjs fetch --all"));
    process.exit(1);
  }
  return data;
}

function rows(data) {
  return (data.videos || []).map((v) => ({
    bvid: v.bvid || "",
    title: v.title || "",
    up: v.up || "",
    duration: v.duration || 0,
    pubdate: date(v.pubtime),
    favdate: date(v.favTime),
    folder: (v.folders || []).map((f) => f.title).join(" / "),
    invalid: v.invalid ? "1" : "",
    link: v.link || (v.bvid ? `https://www.bilibili.com/video/${v.bvid}` : ""),
  }));
}

async function build() {
  const data = await load();
  const list = rows(data);

  const header = ["bvid", "title", "up", "duration", "minutes", "pubdate", "favdate", "folder", "invalid", "link"];
  const csv = [header.join(",")]
    .concat(
      list.map((r) =>
        [r.bvid, r.title, r.up, r.duration, (r.duration / 60).toFixed(1), r.pubdate, r.favdate, r.folder, r.invalid, r.link]
          .map(csvCell)
          .join(",")
      )
    )
    .join("\n");

  await writeTextAtomic(join(VAULT, "00-索引", "目录.csv"), "\ufeff" + csv + "\n");

  // 按收藏夹的 Markdown 目录（只到二级，避免几千行正文）
  const byFolder = new Map();
  for (const r of list) {
    const key = r.folder || "未归类";
    if (!byFolder.has(key)) byFolder.set(key, []);
    byFolder.get(key).push(r);
  }

  const md = [
    "---",
    "type: catalog",
    "title: 收藏夹目录",
    `updated: ${new Date().toISOString().slice(0, 10)}`,
    "---",
    "",
    "# 收藏夹目录",
    "",
    `共 ${list.length} 条（含失效 ${list.filter((r) => r.invalid).length}）。完整字段见 \`目录.csv\`。`,
    "",
  ];
  for (const [folder, items] of [...byFolder].sort((a, b) => b[1].length - a[1].length)) {
    const hours = items.reduce((s, r) => s + r.duration, 0) / 3600;
    md.push(`## ${folder}（${items.length} 条 / ${hours.toFixed(1)} 小时）`, "");
    md.push("| 标题 | UP | 时长 | 收藏 |");
    md.push("| --- | --- | --- | --- |");
    for (const r of items.slice().sort((a, b) => b.favdate.localeCompare(a.favdate)).slice(0, 500)) {
      const title = r.title.replace(/\|/g, "\\|");
      md.push(`| ${r.invalid ? "~~" + title + "~~" : title} | ${r.up} | ${fmtClock(r.duration)} | ${r.favdate} |`);
    }
    if (items.length > 500) md.push(`| …还有 ${items.length - 500} 条见 CSV | | | |`);
    md.push("");
  }
  await writeTextAtomic(join(VAULT, "00-索引", "目录.md"), md.join("\n"));

  const totalH = list.reduce((s, r) => s + r.duration, 0) / 3600;
  console.log(`${green("✓")} vault/00-索引/目录.csv　${list.length} 行`);
  console.log(`${green("✓")} vault/00-索引/目录.md　${byFolder.size} 个收藏夹 / ${totalH.toFixed(1)} 小时`);
}

async function search() {
  const kw = (rest[0] || "").trim();
  if (!kw) { console.error(red("用法：node cli/catalog.mjs search <关键词>")); process.exit(1); }
  const data = await load();
  const lower = kw.toLowerCase();
  const hits = rows(data).filter(
    (r) => r.title.toLowerCase().includes(lower) || r.up.toLowerCase().includes(lower) || r.bvid.toLowerCase() === lower
  );
  console.log(`\n「${kw}」命中 ${hits.length} 条\n`);
  for (const r of hits.slice(0, Number(flag("n", 30)))) {
    console.log(`  ${r.bvid}  ${fmtClock(r.duration).padStart(7)}  ${r.favdate}  ${r.title.slice(0, 52)}`);
    console.log(dim(`           ${r.up} · ${r.folder}`));
  }
  if (hits.length > Number(flag("n", 30))) console.log(dim(`  …还有 ${hits.length - Number(flag("n", 30))} 条`));
}

async function recent() {
  const data = await load();
  const n = Number(flag("n", 20));
  const list = rows(data).filter((r) => !r.invalid).sort((a, b) => b.favdate.localeCompare(a.favdate)).slice(0, n);
  console.log(`\n最近收藏 ${list.length} 条\n`);
  for (const r of list) console.log(`  ${r.favdate}  ${fmtClock(r.duration).padStart(7)}  ${r.bvid}  ${r.title.slice(0, 46)}`);
}

async function stale() {
  const data = await load();
  const list = rows(data).filter((r) => r.invalid);
  console.log(`失效/异常 ${list.length} 条`);
  for (const r of list.slice(0, 50)) console.log(`  ${r.bvid || "(无BV)"}  ${r.title.slice(0, 50)}`);
}

const HELP = `
${bold("bili-fav catalog")} —— 不下载视频的目录层

  node cli/catalog.mjs build            生成 vault/00-索引/目录.csv 与 目录.md
  node cli/catalog.mjs search 关键词    按标题/UP 搜
  node cli/catalog.mjs recent --n 20    最近收藏
  node cli/catalog.mjs stale            失效视频
`;

async function main() {
  ensureDirs();
  switch (cmd) {
    case "build": await build(); break;
    case "search": await search(); break;
    case "recent": await recent(); break;
    case "stale": await stale(); break;
    default: console.log(HELP);
  }
}

main().catch((err) => {
  console.error(red(`\n${err.stack || err.message}`));
  process.exitCode = 1;
});
