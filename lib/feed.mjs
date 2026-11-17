/**
 * 发现层：「替我刷 B 站」。
 *
 * 搜索解决的是"我记得有这么一条，帮我找出来"；发现解决的是"我不知道要看什么"。
 * 两者数据源和排序目标不同：搜索看关键词命中，发现看"跟你口味的相关度 + 新鲜度 + 热度"。
 *
 * 数据源（都是公开接口，已实测可用）：
 * - /x/web-interface/wbi/index/top/feed/rcmd  个性化推荐流（走登录态，最准）
 * - /x/web-interface/popular        热门，20 条/页，带 stat
 * - /x/web-interface/ranking/v2     排行榜，rid=0 全站 100 条
 * - /x/web-interface/wbi/search/type?order=pubdate  主题最新（复用 searchVideos）
 *
 * 兴趣模型不调模型、不建向量：从近一年收藏标题里数 n-gram 文档频率，
 * 用 log(N/df) 当权重。有区分度的重复词权重较高，
 * 满大街的"视频/教程"自然权重低。
 */
import { searchVideos } from "./search-recall.mjs";

const POPULAR = "https://api.bilibili.com/x/web-interface/popular";
const RANKING = "https://api.bilibili.com/x/web-interface/ranking/v2";
const RCMD = "https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd";

/** 常用分区（rid 以 B 站接口为准，传数字也可以）。 */
export const REGIONS = {
  全站: 0, 动画: 1, 音乐: 3, 游戏: 4, 娱乐: 5, 知识: 36, 科技: 188,
  生活: 160, 美食: 211, 鬼畜: 119, 影视: 181, 数码: 95,
};

const num = (v) => Number(v || 0);

const clean = (s) => String(s || "")
  .replace(/<[^>]+>/g, "")
  .replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'")
  .replace(/\s+/g, " ").trim();

/** 热门/排行条目 → 统一形状。 */
export function normalizeFeedItem(v, route) {
  return {
    bvid: v.bvid || "",
    title: clean(v.title),
    author: v.owner?.name || v.author || "",
    mid: num(v.owner?.mid || v.mid),
    durationSec: num(v.duration),
    pubdate: num(v.pubdate) * 1000,
    play: num(v.stat?.view),
    favorites: num(v.stat?.favorite),
    like: num(v.stat?.like),
    danmaku: num(v.stat?.danmaku),
    tag: clean(v.tname),
    description: clean(v.desc),
    isAd: false,
    url: v.bvid ? `https://www.bilibili.com/video/${v.bvid}` : "",
    routes: [route],
    source: "feed",
  };
}

/** 热门：pn 从 1 开始，20 条/页。 */
export async function hotFeed(api, { pn = 1, ps = 20 } = {}) {
  const d = await api.request(POPULAR, { pn, ps });
  return (d?.list || []).map((v) => normalizeFeedItem(v, `热门/第${pn}页`)).filter((v) => v.bvid);
}

/** 排行榜：rid=0 全站，其它为分区。 */
export async function rankFeed(api, { rid = 0 } = {}) {
  const d = await api.request(RANKING, { rid, type: "all" });
  return (d?.list || []).map((v) => normalizeFeedItem(v, `排行/${rid}`)).filter((v) => v.bvid);
}

/** 主题最新：站内搜索按发布时间倒序。 */
export async function topicFeed(api, keyword, { page = 1 } = {}) {
  const r = await searchVideos(api, keyword, { order: "pubdate", page });
  return r.items.map((it) => ({ ...it, source: "feed", routes: [`主题/${keyword}`] }));
}

/**
 * 个性化推荐流：B 站自己的推荐模型，按登录态给。
 * 返回的 item[] 里夹着广告卡（没有 bvid），必须按 bvid 过滤。
 * fresh_idx 递增 = 换一批。
 */
export async function rcmdFeed(api, { ps = 8, freshIdx = 1, freshType = 4 } = {}) {
  const d = await api.request(RCMD, { ps, fresh_type: freshType, fresh_idx: freshIdx, feed_version: "V8" });
  return (d?.item || [])
    .filter((v) => v && v.bvid)
    .map((v) => ({
      ...normalizeFeedItem(v, "推荐流"),
      // rcmd 不给收藏数，热度只靠播放/点赞，免得被 0 收藏拉低
      favorites: num(v.stat?.favorite),
    }));
}

// ---------------------------------------------------------------- 兴趣模型

/** 虚词/代词不配当兴趣词：中文里"真的有""是为了""本视频"这种 n-gram 只制造噪声。 */
const NOISE_CHAR = /[的了是在有和与就也都这那你我他她它把被从而很太真本吗呢吧啊哦嗯个一]/;

/** 放哪都对的通用词：它们不是口味，是标题模板。 */
const GENERIC = new Set([
  "来自", "出处", "评论区", "看看", "适合", "一集", "以后", "继续", "终极", "模拟",
  "不同", "一直", "东西", "时候", "现在", "大家", "我们", "你们", "自己", "什么",
  "怎么", "这个", "那个", "一个", "没有", "就是", "还是", "可以", "这样", "那样",
  "最后", "第一", "第二", "真的", "感觉", "知道", "发现", "记得", "一起", "已经",
  "开始", "结束", "完整", "版本", "更新", "介绍", "推荐", "分享", "教学", "讲解",
  "分析", "测评", "实况", "直播", "搬运", "字幕", "中文", "高清", "互联网", "真的吗",
  "如果", "为何", "因为", "所以", "但是", "不过", "其实", "然后", "成为", "每天",
  "不出", "直接", "动态", "如何", "为什么",
]);

/** CJK 2–4 元组 + 拉丁词（≥3 字符），小写。 */
export function gramsOf(text) {
  const out = new Set();
  const s = String(text || "").toLowerCase();
  for (const seg of s.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const t = seg[0];
    for (const n of [2, 3, 4]) {
      for (let i = 0; i + n <= t.length; i++) {
        const g = t.slice(i, i + n);
        if (n <= 3 && NOISE_CHAR.test(g)) continue;
        if (NOISE_CHAR.test(g[0]) || NOISE_CHAR.test(g[g.length - 1])) continue;
        out.add(g);
      }
    }
  }
  for (const m of s.matchAll(/[a-z][a-z0-9._+-]{2,}/g)) out.add(m[0]);
  return [...out];
}

/**
 * 从收藏标题建兴趣模型。
 * @param {{videos: Array<object>}} favs
 * @param {{recentDays?: number, sample?: number, minDf?: number, maxDfRatio?: number}} opts
 * @returns {{weights: Map<string, number>, sample: number, at: number}}
 */
export function buildInterestModel(favs, { recentDays = 365, sample = 1500, minDf = 4, maxDfRatio = 0.35 } = {}) {
  const nowSec = Date.now() / 1000;
  const list = (favs?.videos || [])
    .filter((v) => v?.title && v.title !== "已失效视频" && !v.invalid)
    .filter((v) => !recentDays || !v.favTime || v.favTime > nowSec - recentDays * 86400)
    .sort((a, b) => num(b.favTime) - num(a.favTime))
    .slice(0, sample);
  const df = new Map();
  for (const v of list) {
    for (const g of gramsOf(v.title)) df.set(g, (df.get(g) || 0) + 1);
  }
  const n = list.length;
  // 小语料（测试或刚建库）不能用比例砍：n=6 时 35% 只剩 2，什么都留不下。
  const maxDf = Math.max(minDf * 2, Math.floor(n * maxDfRatio));
  const weights = new Map();
  for (const [g, d] of df) {
    if (d < minDf || d > maxDf || GENERIC.has(g)) continue;
    // 上限 4.5：只出现 4–8 次的词虽然稀有，也不该一个人主导整条排序
    weights.set(g, Math.min(4.5, Math.log((n + 1) / (d + 1))));
  }
  return { weights, sample: n, at: Date.now() };
}

/**
 * 在文本里找命中的兴趣词（每个位置取最长匹配，再合并重叠）。
 * 返回 {score, phrases}：score 用权重×长度，phrases 给"为什么推给你"。
 */
export function matchPhrases(text, model, { maxPhrases = 3, corpusDf = null } = {}) {
  const low = String(text || "").toLowerCase();
  const spans = [];
  for (let i = 0; i < low.length; i++) {
    for (let len = 4; len >= 2; len--) {
      const g = low.slice(i, i + len);
      const w = model?.weights?.get(g);
      if (w != null) { spans.push({ s: i, e: i + len, len, w }); break; }
    }
  }
  // 合并重叠：同一段只算一次，保留权重×长度更大的那个
  spans.sort((a, b) => a.s - b.s || b.len - a.len);
  const kept = [];
  for (const sp of spans) {
    const last = kept[kept.length - 1];
    if (last && sp.s < last.e) {
      if (sp.w * sp.len > last.w * last.len) kept[kept.length - 1] = sp;
      continue;
    }
    kept.push(sp);
  }
  const score = kept.reduce((sum, sp) => sum + sp.w * Math.min(2, sp.len / 2), 0);
  // 标题和简介会命中同一批词：去重，并丢掉被更长词包住的短词。
  // 展示只留"够独特"的词（w≥2.2 ≈ 出现在 ≤5% 的收藏标题里），
  // 否则理由里全是"来自""评论区"这种放哪都对的词。
  const sorted = kept
    .filter((sp) => {
      const p = low.slice(sp.s, sp.e);
      // 候选池里到处都是的短词（不知道/直接/全网）不是口味，是标题模板
      if (corpusDf && (corpusDf.get(p) ?? 0) > 3 && p.length < 4) return false;
      return p.length >= 3 ? sp.w >= 2.2 : sp.w >= 4.0;
    })
    .sort((a, b) => (b.e - b.s) - (a.e - a.s) || b.w - a.w);
  const phrases = [];
  for (const sp of sorted) {
    const p = low.slice(sp.s, sp.e);
    if (phrases.includes(p)) continue;
    if (phrases.some((q) => q.includes(p))) continue;
    phrases.push(p);
    if (phrases.length >= maxPhrases) break;
  }
  return { score: +score.toFixed(3), phrases };
}

/** 发现排序：兴趣为主，热度与新鲜度只做修正，不让大流量把口味压死。 */
export function scoreFeedItem(item, model, { days = 0, corpusDf = null, boost = 0 } = {}) {
  // 只看标题：简介是关键词堆砌的重灾区，用它会推出"评论区/来自/出处"这种理由
  const m = matchPhrases(item.title, model, { corpusDf });
  const pop = Math.log10(1 + num(item.play)) / 6 * 0.6 + Math.log10(1 + num(item.favorites)) / 6 * 0.9;
  // 新鲜度固定看 7 天，跟 --days 窗口无关：窗口是"允许的范围"，不是"新"的定义
  const fresh = item.pubdate && Date.now() - item.pubdate <= 7 * 86400_000 ? 0.15 : 0;
  const score = m.score * 0.9 + pop + fresh + boost;
  const reasons = [];
  if (boost) reasons.push("B站推荐流");
  if (m.phrases.length) reasons.push(`兴趣命中「${m.phrases.join("、")}」`);
  if (num(item.favorites) >= 10000) reasons.push(`收藏 ${(num(item.favorites) / 10000).toFixed(1)} 万`);
  if (fresh) reasons.push("近 7 天");
  return { item, score: +score.toFixed(3), interest: m.score, phrases: m.phrases, reasons };
}


/** 候选池的词频：用来把"这批候选里到处都是的词"从推荐理由里剔掉。 */
export function buildCorpusDf(items) {
  const df = new Map();
  for (const it of items || []) {
    for (const g of new Set(gramsOf(it.title))) df.set(g, (df.get(g) || 0) + 1);
  }
  return df;
}
