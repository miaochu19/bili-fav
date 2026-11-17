/**
 * 召回层：站内搜索 / UP 搜索 / UP 空间内搜索 / 相关推荐 / 本地收藏先验。
 *
 * 设计要点：
 * - 站内搜索每路只取 1 页（20 条），靠"多排序"扩召回而不是靠翻页；
 * - 空 bvid（广告位/未上架）直接丢；广告位保留但打标，交给重排降权；
 * - 本地收藏先命中：已经收藏过的不必再搜，且可以直接定位到笔记；
 * - 所有请求都走 lib/api.mjs（带限速与 412 熔断）与 material 缓存之外的小 TTL 缓存。
 */
import { join } from "node:path";
import { readJson, writeJsonAtomic, sleep } from "./fsx.mjs";
import { signedQuery } from "./wbi.mjs";

const SEARCH = "https://api.bilibili.com/x/web-interface/wbi/search/type";
const SPACE = "https://api.bilibili.com/x/space/wbi/arc/search";
const RELATED = "https://api.bilibili.com/x/web-interface/archive/related";

export const stripEm = (s) => String(s || "")
  .replace(/<[^>]+>/g, "")
  .replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'")
  .replace(/\s+/g, " ").trim();

/** "15:32" / "1:02:03" / 932 → 秒。 */
export function clockToSec(v) {
  if (typeof v === "number") return v;
  const s = String(v || "").trim();
  if (/^\d+$/.test(s)) return Number(s);
  const parts = s.split(":").map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return 0;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

const km = (n) => Number(n || 0);
const toMs = (sec) => (sec ? Number(sec) * 1000 : 0);

/** 站内视频搜索结果 → 统一条目。 */
export function normalizeSearch(r, route) {
  const titleRaw = String(r.title || "");
  return {
    bvid: r.bvid || "",
    title: stripEm(titleRaw),
    titleRaw,
    author: r.author || r.uname || "",
    mid: Number(r.mid || 0),
    durationSec: clockToSec(r.duration),
    pubdate: toMs(r.pubdate || r.senddate),
    play: km(r.play), favorites: km(r.favorites), like: km(r.like), danmaku: km(r.danmaku || r.video_review),
    tag: stripEm(r.tag), description: stripEm(r.description || r.desc),
    typeName: r.typename || "",
    isAd: Boolean(r.is_union_video || r.is_pay || /广告|推广/.test(String(r.title || "")) || !r.bvid),
    url: r.bvid ? `https://www.bilibili.com/video/${r.bvid}` : (r.arcurl || ""),
    routes: [route],
    source: "site",
  };
}

/**
 * 一路站内搜索。
 * order: totalrank | click | pubdate | dm | stow
 */
export async function searchVideos(api, keyword, { order = "totalrank", page = 1, pageSize = 20 } = {}) {
  const q = await signedQuery(api, { search_type: "video", keyword, page, page_size: pageSize, order });
  const d = await api.request(SEARCH, {}, { rawQuery: q });
  const list = d?.result || [];
  return {
    total: Number(d?.numResults || 0),
    items: list.map((r) => normalizeSearch(r, `站内/${order}`)).filter((it) => it.bvid),
  };
}

/** 用户搜索：同名空号会排在前面，必须过滤 videos>0 并按粉丝降序。 */
export async function searchUsers(api, name) {
  const q = await signedQuery(api, { search_type: "bili_user", keyword: name, page: 1, page_size: 20 });
  const d = await api.request(SEARCH, {}, { rawQuery: q });
  const list = (d?.result || [])
    .map((u) => ({ mid: Number(u.mid), name: stripEm(u.uname), fans: km(u.fans), videos: km(u.videos), verified: Boolean(u.official_verify?.type || u.is_upuser) }))
    .filter((u) => u.mid && u.videos > 0);
  const exact = list.filter((u) => u.name === name);
  return (exact.length ? exact : list).sort((a, b) => b.fans - a.fans);
}

/** UP 空间内搜索（服务端 keyword 过滤，精度最高的一路）。 */
export async function searchSpace(api, mid, keyword = "", { ps = 50, pn = 1, order = "pubdate" } = {}) {
  const q = await signedQuery(api, { mid, ps, pn, order, keyword });
  const d = await api.request(SPACE, {}, { rawQuery: q });
  const vlist = d?.list?.vlist || [];
  return vlist.map((v) => ({
    bvid: v.bvid, title: stripEm(v.title), titleRaw: v.title, author: "", mid: Number(mid),
    durationSec: clockToSec(v.length), pubdate: toMs(v.created), play: km(v.play), favorites: km(v.favorites),
    like: 0, danmaku: km(v.video_review), tag: "", description: stripEm(v.description),
    typeName: "", isAd: false, url: `https://www.bilibili.com/video/${v.bvid}`,
    routes: [`UP/${mid}`], source: "space",
  }));
}

/** 相关推荐：从一条"类似的那条"扩 40 条。 */
export async function relatedVideos(api, bvid) {
  const d = await api.request(RELATED, { bvid });
  return (d || []).map((v) => ({
    bvid: v.bvid, title: stripEm(v.title), titleRaw: v.title, author: v.owner?.name || "", mid: Number(v.owner?.mid || 0),
    durationSec: clockToSec(v.duration), pubdate: toMs(v.pubdate), play: km(v.stat?.view), favorites: km(v.stat?.favorite),
    like: km(v.stat?.like), danmaku: km(v.stat?.danmaku), tag: "", description: stripEm(v.desc),
    typeName: "", isAd: false, url: `https://www.bilibili.com/video/${v.bvid}`,
    routes: [`相关/${bvid}`], source: "related",
  }));
}

/** 本地收藏先验：已收藏的直接命中，省一整套请求。 */
export function localRecall({ favs, notes } = {}, query) {
  const tokens = [...(query.ascii || []), ...(query.cjk || []).filter((g) => g.length >= 2)];
  if (!tokens.length) return [];
  const noteMap = new Map(Object.entries(notes || {}).map(([bv, n]) => [bv, n]));
  let strong = tokens.filter((t) => t.length >= 3 || /[a-z]/.test(t));
  // 2 字中文查询（魔圆/苏联/降智）没有 ≥3 字的词，旧规则会让它们在 6000 条收藏里
  // 一条都召回不到；这种情况下把整句关键词当成强词。
  const keyword = String(query.keyword || "").trim();
  if (!strong.length && keyword.length >= 2) strong = [keyword];
  const out = [];
  for (const v of favs?.videos || []) {
    if (!v.bvid) continue;
    const note = noteMap.get(v.bvid);
    // 简介和笔记标题也算 haystack：很多标题里没有的词，简介里有。
    const hay = `${v.title || ""} ${v.up || ""} ${v.intro || ""} ${note?.title || ""} ${(note?.tags || []).join(" ")}`.toLowerCase();
    let hits = 0, strongHit = 0;
    for (const t of tokens) if (hay.includes(t.toLowerCase())) hits++;
    for (const t of strong) if (hay.includes(t.toLowerCase())) strongHit++;
    // 只靠 2 元组撞词不算召回：要么命中一个 3 字以上的词，要么命中 ≥3 个词
    if (hits < 3 && !strongHit) continue;
    out.push({
      bvid: v.bvid, title: v.title || "", titleRaw: v.title || "", author: v.up || "", mid: Number(v.upMid || 0),
      durationSec: Number(v.duration || 0), pubdate: toMs(v.pubtime), play: 0, favorites: 0, like: 0, danmaku: 0,
      tag: "", description: String(v.intro || ""), typeName: "", isAd: Boolean(v.invalid),
      url: v.link || `https://www.bilibili.com/video/${v.bvid}`,
      routes: [note ? "已收藏+已整理" : "已收藏"], source: "local",
      hitCount: hits, notePath: note?.path || null,
    });
  }
  // 本地命中按命中 token 数降序，只留前 12 条避免淹没站内结果
  return out.sort((a, b) => b.hitCount - a.hitCount || Number(Boolean(b.notePath)) - Number(Boolean(a.notePath))).slice(0, 12);
}

/** 小 TTL 缓存：同一查询 6 小时内不再打网络。 */
export function searchCache(dir, { ttl = 6 * 3600_000, now = Date.now } = {}) {
  return {
    async get(key, loader, { refresh = false } = {}) {
      const file = join(dir, `search.${key}.json`);
      const cached = await readJson(file, null).catch(() => null);
      if (!refresh && cached?.version === 1 && now() - cached.at <= ttl) return { ...cached.value, cachedAt: cached.at };
      const value = await loader();
      await writeJsonAtomic(file, { version: 1, at: now(), value });
      return value;
    },
  };
}
