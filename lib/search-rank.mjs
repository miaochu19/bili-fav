/**
 * 候选重排：把一堆搜索结果排成"最可能是你要的那一条"。
 *
 * 原则：
 * - 硬约束（引号短语、≥3 字符的英文/型号 token）不命中就进"最接近"，不硬塞进前几名；
 * - 中文只做加权命中，不做硬约束 —— "四层工作边界"和"四层 PCB"共享 2 元组，硬卡只会漏；
 * - 热度用收藏而非播放，且做 log 归一化，避免热门把精确命中挤下去；
 * - 每条结果都要能解释"为什么排这里"。
 *
 * 2026-11-13 修订：
 * - 去掉 `Math.max(1, top*0.2)` 这个绝对下限。纯中文 2 字查询（魔圆/苏联/降智）最高分
 *   只有 ~0.4，绝对下限 1 会让它们全部 folded，看起来像"站内没有"。
 * - 加"标题最长连续命中"和"中心词（的之后的名词）"两项：改述查询（四个层级的工作边界）
 *   不再输给撞词（大学生资产四个层级）。
 * - 加候选池 IDF：高频 2 元组（视频/教程）自动降权，稀有词（型号、专名）自动升权。
 */

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ");

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 参与打分的文本：标题权重最高，其次 tag/简介。 */
export const haystackOf = (item) =>
  `${norm(item.title)} ${norm(item.tag)} ${norm(item.description)} ${norm(item.author)}`;

const hitScore = (token, field, weight) => {
  const at = field.indexOf(token);
  if (at < 0) return 0;
  // 标题开头命中更可信：位置越靠后越可能是"顺带提到"
  const early = field.length ? at / field.length : 1;
  return weight * (early <= 0.35 ? 1.15 : 1);
};

/**
 * query 的哪一段在 title 里**原样连续**出现，返回最长长度。
 * 这是"改述 vs 撞词"最便宜的判别器：连续 4 字比散落 6 个 2 元组更可信。
 */
export function longestContiguous(queryText, title) {
  const q = norm(queryText).replace(/\s+/g, "");
  const t = norm(title);
  if (!q || !t) return 0;
  let best = 0;
  for (let i = 0; i < q.length; i++) {
    for (let j = i + best + 1; j <= q.length; j++) {
      if (t.includes(q.slice(i, j))) best = j - i;
      else break;
    }
  }
  return best;
}

/** 中心词：「的」之后的部分通常是名词中心语（四个层级的**工作边界**）。 */
const FOCUS_STOP = new Set(["视频", "影片", "内容", "东西", "部分", "时候", "地方"]);
export function focusPhrase(keyword) {
  const s = String(keyword || "").trim();
  const at = s.lastIndexOf("的");
  if (at < 0) return "";
  const tail = s.slice(at + 1).replace(/[的了呢吧啊嘛哦呀]/g, "").trim();
  if (tail.length < 2 || tail.length > 10 || FOCUS_STOP.has(tail)) return "";
  return tail;
}

/**
 * @param {object} item 归一化后的条目
 * @param {object} query parseQuery 的结果
 * @param {{idf?: Map<string, number>, pool?: number}} [ctx] 候选池统计（可选，缺省按无 IDF 处理）
 */
export function scoreItem(item, query, ctx = {}) {
  const title = norm(item.title), tag = norm(item.tag), desc = norm(item.description), author = norm(item.author);
  const haystack = `${title} ${tag} ${desc}`;
  const reasons = [], missing = [];
  let score = 0;
  const idfOf = (t) => clamp(ctx.idf?.get(t) ?? 1, 0.55, 1.45);

  const titleHits = [];
  for (const t of query.ascii || []) {
    const w = 2.0 * idfOf(t);
    const s = hitScore(t, title, w) || hitScore(t, haystack, w * 0.35);
    if (s) { score += s; titleHits.push(t); }
  }
  for (const g of query.cjk || []) {
    const base = g.length >= 4 ? 1.2 : g.length === 3 ? 0.7 : 0.3;
    const w = base * idfOf(g);
    const s = hitScore(g, title, w) || hitScore(g, haystack, w * 0.35);
    if (s) score += s;
  }
  if (titleHits.length) reasons.push(`标题命中 ${titleHits.slice(0, 3).join(" ")}`);

  // 连续命中：比"散落的 2 元组"更有说服力
  const keyword = String(query.keyword || "");
  const contig = longestContiguous(keyword, title);
  if (contig >= 3) {
    score += Math.min(1.8, 0.32 * contig);
    reasons.push(`标题连续命中 ${contig} 字`);
  } else if (contig === 2) {
    score += 0.18;
  }
  const flatKeyword = norm(keyword).replace(/\s+/g, "");
  if (flatKeyword.length >= 3 && title.includes(flatKeyword)) {
    score += 0.5;
    reasons.push("标题完整包含关键词");
  }

  // 中心词：改述查询里最该守住的那半句
  const focus = String(query.focus || focusPhrase(keyword) || "");
  if (focus && focus !== flatKeyword) {
    if (title.includes(focus)) {
      score += Math.min(1.1, 0.22 * focus.length);
      reasons.push(`中心词「${focus}」命中`);
    } else if (haystack.includes(focus)) {
      score += 0.15;
    } else {
      score -= 0.12;
    }
  }

  // 本地收藏命中：用户已经用"收藏"投过票，比站内随便一条更可能是目标
  if (item.source === "local") {
    score += 0.1;
    if (item.notePath) { score += 0.05; reasons.push("本地收藏且已有笔记"); }
    else reasons.push("本地收藏命中");
  }

  // 硬约束
  for (const m of query.must || []) {
    if (!haystack.includes(m)) missing.push(m);
  }
  if (!missing.length && (query.must || []).length) reasons.push(`硬约束全中（${query.must.join(" ")}）`);

  // 时长窗口
  if (query.duration) {
    const { min, max } = query.duration, d = item.durationSec || 0;
    if (d >= min && (max == null || d <= max)) { score += 0.12; reasons.push(`时长 ${Math.round(d / 60)} 分钟在窗口内`); }
    else { score -= 0.18; reasons.push(`时长 ${Math.round(d / 60)} 分钟不在窗口（${min}–${max ?? "∞"}）`); }
  }

  // 时间窗
  if (query.since) {
    const pub = Number(item.pubdate || 0);
    if (pub >= query.since) { score += 0.08; reasons.push(`发布于 ${new Date(pub).toISOString().slice(0, 10)}`); }
    else { score -= 0.25; reasons.push(`发布于 ${new Date(pub).toISOString().slice(0, 10)}，早于时间窗`); }
  }

  // UP 命中
  if (query.up && author.includes(norm(query.up))) { score += 0.25; reasons.push(`UP 命中 ${item.author}`); }

  // 热度（收藏优先）
  const fav = Math.max(0, Number(item.favorites || 0));
  score += Math.min(1, Math.log10(1 + fav) / 6) * 0.1;
  if (fav >= 10000) reasons.push(`收藏 ${(fav / 10000).toFixed(1)} 万`);

  // 惩罚
  if (item.isAd) { score -= 0.5; reasons.push("广告/推广位，已降权"); }
  const play = Number(item.play || 0);
  if (play > 500000 && fav > 0 && play / fav > 80) { score -= 0.06; reasons.push("播放/收藏比偏高，疑似标题党"); }

  return { item, score: +score.toFixed(4), reasons, missing };
}

/** 候选池里的文档频率 → IDF 系数。池子过小或词只出现在一条里，就按上限处理。 */
export function buildIdf(items, query) {
  const pool = (items || []).filter((x) => x && x.bvid);
  const n = pool.length;
  const df = new Map();
  for (const it of pool) {
    const hay = haystackOf(it);
    for (const t of [...(query.ascii || []), ...(query.cjk || [])]) {
      if (hay.includes(t)) df.set(t, (df.get(t) || 0) + 1);
    }
  }
  const idf = new Map();
  for (const [t, d] of df) idf.set(t, 0.55 + 0.9 * (1 - d / Math.max(1, n)));
  return { idf, pool: n };
}

/** 排序 + 分流：硬约束全中的进 hits，其余进 nearMiss（各自列出缺什么）。 */
export function rankItems(items, query, { top = 5, nearMiss = 3, minRelative = 0.35 } = {}) {
  const scored = (items || []).filter((x) => x && x.bvid).map((item) => scoreItem(item, query, buildIdf(items, query)));
  const pass = scored.filter((s) => !s.missing.length).sort((a, b) => b.score - a.score || (b.item.favorites || 0) - (a.item.favorites || 0));
  const fail = scored.filter((s) => s.missing.length).sort((a, b) => b.score - a.score);
  // 相对阈值：只留"跟第一名同一量级"的候选。不能再加绝对下限——纯中文短查询的分数
  // 天然只有 0.3~0.5，任何绝对下限都会把它们整体判死。
  const topScore = pass.length ? pass[0].score : 0;
  const floor = topScore > 0 ? topScore * minRelative : 0;
  const strong = pass.filter((s) => s.score >= floor && s.score > 0);
  // 时间窗/时长是"偏好"不是"硬约束"：越界照样显示，但要说清有多少条真的满足
  const inSince = query.since ? pass.filter((s) => Number(s.item.pubdate || 0) >= query.since).length : null;
  const inDuration = query.duration
    ? pass.filter((s) => { const d = s.item.durationSec || 0; return d >= query.duration.min && (query.duration.max == null || d <= query.duration.max); }).length
    : null;
  return {
    hits: strong.slice(0, top),
    nearMiss: fail.slice(0, nearMiss).map((s) => ({ ...s, missing: s.missing })),
    stats: {
      candidates: scored.length, passed: pass.length, strong: strong.length,
      weak: pass.length - strong.length, dropped: fail.length,
      topScore: +topScore.toFixed(4), floor: +floor.toFixed(4), inSince, inDuration,
    },
  };
}

/** 去重：同一 bvid 保留先到的路由，但合并路由来源。 */
export function dedupe(items) {
  const byBv = new Map();
  for (const it of items || []) {
    if (!it?.bvid) continue;
    const prev = byBv.get(it.bvid);
    if (!prev) byBv.set(it.bvid, { ...it, routes: [...new Set(it.routes || [])] });
    else prev.routes = [...new Set([...(prev.routes || []), ...(it.routes || [])])];
  }
  return [...byBv.values()];
}

/** 一行理由，给终端用。 */
export function explain(entry) {
  const it = entry.item;
  const head = `${it.bvid}  ${String(Math.round((it.durationSec || 0) / 60)).padStart(3)}min  ${String(it.author || "").slice(0, 12).padEnd(12)}  ${it.title.slice(0, 46)}`;
  return { head, why: entry.reasons.slice(0, 3).join("；"), missing: entry.missing?.join(" ") };
}
