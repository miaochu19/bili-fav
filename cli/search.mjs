#!/usr/bin/env node
// 站内搜索：把"我记不清具体名字的那条视频"从 B 站搜索里捞出来。
//
// 多路召回（站内多排序 / UP 空间 / 相关推荐 / 本地收藏）→ 硬约束过滤 → 可解释重排。
// 不做语义理解：中文只加权，英文/型号/引号短语才当硬约束；找不到就报"最接近的缺什么"。
import { join } from "node:path";
import { FILES, CACHE, ensureDirs, rel } from "../lib/paths.mjs";
import { readJson } from "../lib/fsx.mjs";
import { loadCookies } from "../lib/cookies.mjs";
import { BiliApi } from "../lib/api.mjs";
import { digest } from "../lib/material-cache.mjs";
import { parseQuery } from "../lib/search-query.mjs";
import { dedupe, rankItems } from "../lib/search-rank.mjs";
import { searchVideos, searchUsers, searchSpace, relatedVideos, localRecall, searchCache } from "../lib/search-recall.mjs";

const argv = process.argv.slice(2);
const rest = argv;
function flag(name, fallback) {
  const i = rest.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = rest[i + 1];
  return next && !next.startsWith("--") ? next : true;
}
function list(name, fallback) {
  const v = flag(name, fallback);
  return typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : fallback;
}

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c("2"), bold = c("1"), green = c("32"), yellow = c("33"), red = c("31");

// 位置参数 = 查询文本；带值的开关要跳过它的值，否则值会被当成查询词
const VALUED = new Set(["top", "pages", "orders", "up", "duration", "since", "related"]);
const positional = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (/^--[a-z-]+$/.test(a)) { if (VALUED.has(a.slice(2))) i++; continue; }
  positional.push(a);
}
const rawQuery = positional.join(" ").trim();

if (!rawQuery || rest.includes("--help") || rawQuery === "help") {
  console.log(`
${bold("bili-fav search")} —— 从 B 站搜索里定位"你要的那条视频"

  node cli/search.mjs "那个讲四层工作边界的视频"
  node cli/search.mjs "DSH 插件" --top 5 --since 2026-10-01
  node cli/search.mjs "agent 记忆" --duration 5-30 --orders totalrank,pubdate,click
  node cli/search.mjs "四层工作边界" --up 示例作者        # 走 UP 空间内搜索
  node cli/search.mjs --related BV1xxxxxxxxx              # 从种子视频扩展
  node cli/search.mjs "X500 评测" --json --near

  选项
  --top N              显示前 N 条（默认 5）
  --pages N            站内每路翻页数（默认 1，慎用：每页 20 条）
  --orders a,b         站内排序组合（默认 totalrank,pubdate；可加 click/dm/stow）
  --up NAME            指定 UP：先搜用户再搜其空间（精度最高）
  --duration 5-30      时长窗（分钟），也接受 10 左右 / 20 以上
  --since 2026-10-01   发布时间下限（也接受「最近一周」这类说法写在查询里）
  --related BVxxxx     从一条视频的相关推荐扩展召回
  --no-local           不做本地收藏先验
  --no-space           允许 --up 时不搜空间
  --near               额外列出"最接近但硬约束没全中"的候选
  --refresh            忽略 6 小时搜索缓存
  --json               机器可读输出
`);
  process.exit(rest.includes("--help") || rawQuery === "help" ? 0 : 1);
}

ensureDirs();
const parsed = parseQuery(rawQuery);
if (typeof flag("duration") === "string") {
  const [a, b] = String(flag("duration")).split(/[-–~]/);
  parsed.duration = { min: Number(a) || 0, max: b ? Number(b) : null };
}
if (typeof flag("since") === "string") {
  const t = Date.parse(String(flag("since")));
  if (Number.isFinite(t)) parsed.since = t; else { console.error(red(`--since 解析失败：${flag("since")}`)); process.exit(1); }
}
if (typeof flag("up") === "string") parsed.up = String(flag("up"));
const top = Math.max(1, Number(flag("top", 5)) || 5);
const pages = Math.max(1, Math.min(5, Number(flag("pages", 1)) || 1));
const orders = list("orders", ["totalrank", "pubdate"]);
const wantNear = rest.includes("--near");
const json = rest.includes("--json");
const relatedSeed = typeof flag("related") === "string" ? String(flag("related")) : null;

const notes = (await readJson(FILES.notes, {})) || {};
const favs = rest.includes("--no-local") ? null : await readJson(FILES.favs, null);

const api = new BiliApi({ cookies: (await loadCookies({})).cookies, log: () => {} });
await api.init();

const cacheKey = digest(JSON.stringify({ q: rawQuery, orders, pages, up: parsed.up || null, related: relatedSeed, local: Boolean(favs) })).slice(0, 16);
const cache = searchCache(join(CACHE, "_search"), { ttl: 6 * 3600_000 });
const refresh = rest.includes("--refresh");

const t0 = Date.now();
const { value, cachedAt } = await cache.get(cacheKey, async () => {
  const local = favs ? localRecall({ favs, notes }, parsed) : [];
  const site = [];
  for (const order of orders) {
    for (let page = 1; page <= pages; page++) {
      const r = await searchVideos(api, parsed.keyword, { order, page });
      site.push(...r.items);
      if (r.items.length < 20) break;
    }
  }
  const space = [];
  if (parsed.up && !rest.includes("--no-space")) {
    const users = await searchUsers(api, parsed.up);
    if (users[0]) {
      // 服务端 keyword 过滤（旧版传空串，只能看到 UP 最新 50 条）
      const kw = parsed.keyword && parsed.keyword !== parsed.up ? parsed.keyword : "";
      let hits = [];
      for (let pn = 1; pn <= 2; pn++) {
        const page = await searchSpace(api, users[0].mid, kw, { pn });
        hits.push(...page);
        if (page.length < 50) break;
      }
      if (!hits.length && kw) hits = await searchSpace(api, users[0].mid, "", { pn: 1 });
      for (const it of hits) it.author = users[0].name;
      space.push(...hits);
    }
  }
  const related = relatedSeed ? await relatedVideos(api, relatedSeed) : [];
  return { local, site, space, related };
}, { refresh }).then((v) => ({ value: v, cachedAt: v.cachedAt ?? null }));

const all = dedupe([...value.local, ...value.space, ...value.site, ...value.related]);
const ranked = rankItems(all, parsed, { top, nearMiss: 3 });
const result = {
  query: rawQuery,
  parsed: { keyword: parsed.keyword, must: parsed.must, duration: parsed.duration, since: parsed.since ? new Date(parsed.since).toISOString().slice(0, 10) : null, up: parsed.up, ascii: parsed.ascii },
  recall: { local: value.local.length, space: value.space.length, site: value.site.length, related: value.related.length, unique: all.length, cachedAt },
  stats: ranked.stats,
  requests: api.calls,
  elapsedMs: Date.now() - t0,
  hits: ranked.hits.map((h) => ({ bvid: h.item.bvid, title: h.item.title, author: h.item.author, minutes: Math.round((h.item.durationSec || 0) / 60), pubdate: h.item.pubdate ? new Date(h.item.pubdate).toISOString().slice(0, 10) : null, favorites: h.item.favorites, routes: h.item.routes, url: h.item.url, note: h.item.notePath || null, score: h.score, reasons: h.reasons })),
  nearMiss: ranked.nearMiss.map((n) => ({ bvid: n.item.bvid, title: n.item.title, author: n.item.author, missing: n.missing, score: n.score })),
};

if (json) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(ranked.hits.length ? 0 : 2);
}

console.log(`\n${bold("搜索")} ${rawQuery}`);
const bits = [`关键词「${parsed.keyword}」`];
if (parsed.must.length) bits.push(`硬约束 ${parsed.must.join(" ")}`);
if (parsed.duration) bits.push(`时长 ${parsed.duration.min}–${parsed.duration.max ?? "∞"} 分钟`);
if (parsed.since) bits.push(`发布 ≥ ${result.parsed.since}`);
if (parsed.up) bits.push(`UP ${parsed.up}`);
console.log(dim(`  ${bits.join("　")}`));
console.log(dim(`  召回：本地 ${result.recall.local} · UP空间 ${result.recall.space} · 站内 ${result.recall.site} · 相关 ${result.recall.related} → 去重 ${result.recall.unique} 条；通过硬约束 ${ranked.stats.passed}（强相关 ${ranked.stats.strong}）${cachedAt ? `；缓存于 ${new Date(cachedAt).toISOString().slice(11, 16)}` : ""}`));

if (!ranked.hits.length) {
  console.log(yellow("\n  没有通过硬约束的候选。下面是最接近的，缺什么写在后面："));
  for (const n of result.nearMiss) {
    console.log(`  - ${n.bvid}  ${String(n.title).slice(0, 46)}  ${String(n.author).slice(0, 12)}`);
    console.log(dim(`    缺：${n.missing.join(" ")}`));
  }
  console.log(dim(`\n  建议：去掉硬约束词、放宽 --duration/--since，或改用 --up <UP名> 走空间内搜索。\n`));
  process.exitCode = 2;
} else {
  result.hits.forEach((h, i) => {
    console.log(`\n  ${String(i + 1).padStart(2)}. ${green(h.bvid)}  ${String(h.minutes).padStart(3)}min  ${String(h.author).slice(0, 12).padEnd(12)}  ${h.title.slice(0, 52)}`);
    const meta = [h.pubdate || "????-??-??", h.favorites ? `收藏 ${h.favorites}` : null, h.routes.join(" + "), h.note ? "已有笔记" : null].filter(Boolean);
    console.log(dim(`      ${meta.join("  ")}`));
    if (h.reasons.length) console.log(dim(`      为什么：${h.reasons.slice(0, 3).join("；")}`));
  });
  if (ranked.stats.weak) console.log(dim(`\n  （另有 ${ranked.stats.weak} 条通过了硬约束但得分远低于第一名，已折叠；加 --near 或放宽条件可再看）`));
  if (ranked.stats.inSince === 0) console.log(yellow(`  ! 没有一条满足发布 ≥ ${result.parsed.since}：下面是按相关度排的，时间窗未生效`));
  if (ranked.stats.inDuration === 0) console.log(yellow(`  ! 没有一条落在时长窗内：时长条件未生效，可换 --duration 或去掉`));
  if (wantNear && result.nearMiss.length) {
    console.log(yellow(`\n  最接近（硬约束未全中）：`));
    for (const n of result.nearMiss) console.log(dim(`  - ${n.bvid} ${n.title.slice(0, 40)}   缺：${n.missing.join(" ")}`));
  }
  console.log(dim(`\n  ${api.calls} 个请求 / ${result.elapsedMs} ms。命中后：node cli\\note.mjs prepare ${ranked.hits[0].item.bvid}\n`));
}
