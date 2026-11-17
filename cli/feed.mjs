#!/usr/bin/env node
// 替我刷 B 站：热门 / 排行榜 / 主题最新 → 排掉已收藏 → 按你的收藏口味排序。
//
// 和 search.mjs 的分工：search 是"我记得有这么一条"，feed 是"我不知道看什么"。
// 排序只做可解释的加法：兴趣词命中（收藏标题里的 n-gram）× 权重 + 热度 + 新鲜度。
import { FILES, ensureDirs } from "../lib/paths.mjs";
import { readJson } from "../lib/fsx.mjs";
import { feedVideos } from "../lib/ops.mjs";
import { REGIONS } from "../lib/feed.mjs";

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
function val(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}
const num = (v, d) => (Number.isFinite(Number(v)) && v !== true ? Number(v) : d);

if (has("help") || argv.length === 0) {
  console.log(`
bili-fav feed —— 刷 B 站，按你的收藏口味挑（默认排除已收藏）

  node cli/feed.mjs                              # 热门 2 页
  node cli/feed.mjs --hot 3 --top 15             # 热门 3 页
  node cli/feed.mjs --rank 科技                  # 排行榜（分区名见下）
  node cli/feed.mjs --topic "DSH 插件" --days 14 --min 5 --max 40
  node cli/feed.mjs --hot 2 --rank 知识 --json

  选项
  --rcmd N           个性化推荐流页数，1–5（默认 2，8 条/页，走登录态）
  --no-rcmd          不要推荐流
  --hot N            热门页数，0–3（默认 2）
  --no-hot           不要热门
  --rank 分区        排行榜：${Object.keys(REGIONS).join(" / ")}（也可直接传 rid 数字）
  --topic 词         主题最新（站内搜索按发布时间倒序）
  --days N           只要最近 N 天发布的（默认 30；0=不限）
  --min / --max      时长窗（分钟）
  --top N            显示前 N 条（默认 10）
  --min-interest N   兴趣分下限（默认：无 topic 时 1，有 topic 时 0）
  --all              不排除已收藏
  --refresh          忽略 30 分钟缓存
  --json             机器可读
`);
  process.exit(argv.length === 0 ? 1 : 0);
}

ensureDirs();
const favs = await readJson(FILES.favs, null);
if (!favs) {
  console.error("还没有 data/favs.json：先 node cli/fav.mjs fetch --all");
  process.exit(1);
}

const topic = typeof val("topic") === "string" ? val("topic") : null;
const rankRaw = val("rank", null);
const rank = rankRaw === true || rankRaw == null ? null : rankRaw;
const result = await feedVideos({
  topic,
  rcmd: has("no-rcmd") ? 0 : num(val("rcmd", 2), 2),
  hot: has("no-hot") ? 0 : num(val("hot", 2), 2),
  rank,
  days: num(val("days", 30), 30),
  minMinutes: num(val("min", 0), 0),
  maxMinutes: num(val("max", 0), 0),
  top: num(val("top", 10), 10),
  includeFaved: has("all"),
  minInterest: val("min-interest", null) === null ? null : num(val("min-interest"), 0),
  refresh: has("refresh"),
});

if (has("json")) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.items.length ? 0 : 2);
}

const f = result.filter;
console.log(`\n刷 B 站　${[
  f.topic ? `主题「${f.topic}」` : null,
  f.rcmd ? `推荐流 ${f.rcmd} 页` : null,
  f.hot ? `热门 ${f.hot} 页` : null,
  f.rank != null ? `排行 ${f.rank}` : null,
  f.days ? `近 ${f.days} 天` : null,
  f.minMinutes || f.maxMinutes ? `时长 ${f.minMinutes}-${f.maxMinutes || "∞"} 分钟` : null,
].filter(Boolean).join("　") || "热门"}`);
console.log(`  兴趣模型：${result.model.sample} 条收藏标题 / ${result.model.grams} 个词；` +
  `推荐流 ${result.recall.rcmd} · 候选 ${result.recall.sources} → 已收藏 ${result.recall.faved} · 时长 ${result.recall.duration} · 过期 ${result.recall.stale} → 留下 ${result.items.length}`);

if (!result.items.length) {
  console.log("\n  没有符合条件的新视频。放宽 --days/--min/--max，或去掉 --topic 试试。\n");
  process.exitCode = 2;
} else {
  result.items.forEach((it, i) => {
    console.log(`\n  ${String(i + 1).padStart(2)}. ${it.bvid}  ${String(it.minutes).padStart(3)}min  ${String(it.author || "").slice(0, 12).padEnd(12)}  ${it.title.slice(0, 52)}`);
    const meta = [it.pubdate || "????-??-??",
      it.views ? `播放 ${it.views >= 10000 ? (it.views / 10000).toFixed(1) + " 万" : it.views}` : null,
      it.favorites ? `收藏 ${it.favorites}` : null,
      it.routes?.join(" + ") || null].filter(Boolean);
    console.log(`      ${meta.join("  ")}`);
    if (it.reasons?.length) console.log(`      为什么：${it.reasons.slice(0, 3).join("；")}`);
  });
  console.log(`\n  看中哪条：node cli\\note.mjs prepare <BV>\n`);
}
