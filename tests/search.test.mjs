import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuery, parseDuration, parseSince, parseUp, denoise, parseCnNumber } from "../lib/search-query.mjs";
import { scoreItem, rankItems, dedupe } from "../lib/search-rank.mjs";
import { clockToSec, localRecall, normalizeSearch, stripEm } from "../lib/search-recall.mjs";

const target = {
  bvid: "BVtest000011", title: "实用指南：讲清 Agent 的四层工作边界",
  author: "示例作者A", durationSec: 319, pubdate: Date.parse("2026-09-11") , favorites: 44353, play: 414296,
  tag: "AI,Skill", description: "Agent 的四层边界", routes: ["站内/totalrank"],
};
const pcb = {
  bvid: "BVtest000012", title: "如何用 30 分钟画一块四层 PCB",
  author: "示例作者B", durationSec: 2220, pubdate: Date.parse("2026-09-11"), favorites: 8000, play: 90000,
  tag: "PCB", description: "四层板", routes: ["站内/totalrank"],
};

test("search: 口语查询去掉口水词，只留可验证的关键词与约束", () => {
  const p = parseQuery("那个讲四层工作边界的视频");
  assert.equal(p.keyword, "四层工作边界");
  assert.equal(p.duration, null);
  assert.ok(p.cjk.includes("四层工作") && p.cjk.includes("工作边界"), "2–4 元组里应有长片段");
  const q = parseQuery("最近一周 10 分钟左右的 DSH 插件");
  assert.equal(q.keyword, "DSH 插件");
  assert.deepEqual(q.must, ["dsh"]);
  assert.deepEqual(q.duration, { min: 6, max: 16 });
  assert.ok(q.since > Date.now() - 8 * 86400_000);
  const up = parseQuery("示例作者A讲的 agent 边界");
  assert.equal(up.up, "示例作者A");
  assert.equal(up.keyword, "agent 边界");
});

test("search: 时长/时间/UP/中文数字解析", () => {
  assert.deepEqual(parseDuration("5-30 分钟"), { min: 5, max: 30 });
  assert.deepEqual(parseDuration("十分钟左右"), { min: 6, max: 16 });
  assert.deepEqual(parseDuration("20 分钟以上"), { min: 20, max: null });
  assert.deepEqual(parseDuration("半小时以内"), { min: 0, max: 35 });
  assert.deepEqual(parseDuration("1 小时以内"), { min: 0, max: 60 });
  assert.equal(parseDuration("没有时长"), null);
  assert.equal(new Date(parseSince("2026年")).getFullYear(), 2026);
  assert.equal(new Date(parseSince("去年")).getFullYear(), new Date().getFullYear() - 1);
  assert.equal(parseUp("@示例作者"), "示例作者");
  assert.equal(parseUp("没有指向"), null);
  assert.equal(parseCnNumber("十二"), 12);
  assert.equal(parseCnNumber("二十"), 20);
  assert.equal(denoise("那个讲的视频 四层 工作边界"), "四层 工作边界");
});

test("search: 重排把精确命中排在撞词之上，并且差距足够大", () => {
  const p = parseQuery("那个讲四层工作边界的视频");
  const out = rankItems([pcb, target], p, { top: 5 });
  assert.equal(out.hits.length, 1, "撞词的 PCB 应被相对阈值折叠");
  assert.equal(out.hits[0].item.bvid, target.bvid);
  assert.equal(out.stats.passed, 2);
  assert.equal(out.stats.strong, 1);
});

test("search: 英文/型号是硬约束，不命中进最接近而不是硬塞", () => {
  const p = parseQuery("DSH 插件");
  const miss = { ...target, title: "一个普通插件推荐", tag: "", description: "" };
  const out = rankItems([miss, { ...pcb, title: "DSH 插件合集", tag: "", description: "" }], p, { top: 5 });
  assert.equal(out.hits.length, 1);
  assert.equal(out.nearMiss.length, 1);
  assert.deepEqual(out.nearMiss[0].missing, ["dsh"]);
  assert.equal(out.stats.dropped, 1);
});

test("search: 广告位降权、无 bvid 丢弃、重复 bvid 合并路由", () => {
  const p = parseQuery("DSH 插件");
  const ad = { ...target, bvid: "BVad0000001", title: "DSH 插件推荐", isAd: true, favorites: 50000 };
  const good = { ...target, bvid: "BVgood00001", title: "DSH 插件实测", isAd: false, favorites: 2000 };
  const out = rankItems([ad, good, { ...good, bvid: "" }], p, { top: 5 });
  assert.equal(out.hits[0].item.bvid, good.bvid, "广告即使收藏更高也应排后");
  assert.ok(out.hits[0].score > out.hits[1].score);
  const merged = dedupe([{ ...good, routes: ["站内/totalrank"] }, { ...good, routes: ["UP/123"] }]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].routes, ["站内/totalrank", "UP/123"]);
});

test("search: 时间窗与时长是偏好，越界照样显示但会报 inSince/inDuration", () => {
  const p = parseQuery("DSH 插件");
  p.since = Date.parse("2030-01-01"); p.duration = { min: 60, max: 120 };
  const item = { ...target, title: "DSH 插件清单", pubdate: Date.parse("2026-10-01"), durationSec: 300 };
  const out = rankItems([item], p, { top: 5 });
  assert.equal(out.hits.length, 1);
  assert.equal(out.stats.inSince, 0);
  assert.equal(out.stats.inDuration, 0);
  assert.ok(scoreItem(item, p).reasons.some((r) => r.includes("早于时间窗")));
});

test("search: 本地收藏召回要求强词或 ≥3 个词命中，避免 2 元组撞词", () => {
  const p = parseQuery("四层工作边界");
  const favs = { videos: [
    { bvid: "BVtest000011", title: "讲清 Agent 的四层工作边界", up: "示例作者A", duration: 319, pubtime: 1790000000 },
    { bvid: "BVother0001", title: "工作日常", up: "某人", duration: 100, pubtime: 1790000000 },
  ] };
  const hits = localRecall({ favs, notes: { BVtest000011: { path: "x.md" } } }, p);
  assert.deepEqual(hits.map((h) => h.bvid), ["BVtest000011"]);
  assert.equal(hits[0].notePath, "x.md");
  assert.ok(hits[0].routes.includes("已收藏+已整理"));
});

test("search: 结果归一化去掉高亮标签、时长串转秒、广告位打标", () => {
  assert.equal(stripEm('<em class="keyword">DSH</em> 插件 &amp; 教程'), "DSH 插件 & 教程");
  assert.equal(clockToSec("15:32"), 932);
  assert.equal(clockToSec("1:02:03"), 3723);
  assert.equal(clockToSec(87), 87);
  const n = normalizeSearch({ bvid: "BV1x", title: "<em>四层</em>工作边界", author: "桌上", duration: "5:19", pubdate: 1790000000, play: 10, favorites: 2, tag: "<em>AI</em>", description: "desc", is_union_video: 1 }, "站内/click");
  assert.equal(n.title, "四层工作边界");
  assert.equal(n.durationSec, 319);
  assert.equal(n.isAd, true);
  assert.deepEqual(n.routes, ["站内/click"]);
});

// ---------------------------------------------------------------- 2026-11-13 回归：短查询 / 改述 / 发现

import { longestContiguous, focusPhrase } from "../lib/search-rank.mjs";
import { buildInterestModel, matchPhrases, rcmdFeed, scoreFeedItem } from "../lib/feed.mjs";

const fav = (bvid, title, extra = {}) => ({
  bvid, title, author: "某UP", durationSec: 300, pubdate: Date.parse("2026-10-01"),
  favorites: 1000, play: 20000, tag: "", description: "", routes: ["站内/totalrank"], ...extra,
});

test("search: 纯中文 2 字查询不再被绝对下限判死", () => {
  const p = parseQuery("魔圆");
  const items = [
    fav("BV1aaaaaaa1", "【魔圆】焰的新剧场版解析"),
    fav("BV1aaaaaaa2", "魔圆 十年后的同人游戏"),
    fav("BV1aaaaaaa3", "试试这个红烧肉教程", { favorites: 99000 }),
  ];
  const out = rankItems(items, p, { top: 5 });
  assert.ok(out.stats.strong > 0, "2 字查询必须至少有一条通过相对阈值");
  assert.equal(out.hits.length, 2, "不相关的红烧肉不该挤进来");
});

test("search: 本地收藏对 2 字中文查询也能召回（降智）", () => {
  const p = parseQuery("降智");
  const favs = { videos: [
    { bvid: "BV1bbbbbbb1", title: "你的GPT被降智了吗？", up: "某人", intro: "如何判断模型降智", duration: 351, pubtime: 1790000000 },
    { bvid: "BV1bbbbbbb2", title: "今天的午饭", up: "某人", intro: "", duration: 200, pubtime: 1790000000 },
  ] };
  const hits = localRecall({ favs, notes: {} }, p);
  assert.deepEqual(hits.map((h) => h.bvid), ["BV1bbbbbbb1"]);
});

test("search: 改述查询里中心词命中的那条排第一", () => {
  const p = parseQuery("四个层级的工作边界");
  assert.equal(p.focus, "工作边界");
  const target = fav("BV1ccccccc1", "实用指南：讲清 Agent 的四层工作边界", { favorites: 44353 });
  const decoy = fav("BV1ccccccc2", "大学生资产四个层级，你在第几层？", { favorites: 8000 });
  const out = rankItems([decoy, target], p, { top: 2 });
  assert.equal(out.hits[0].item.bvid, target.bvid);
  assert.ok(out.hits[0].reasons.some((r) => r.includes("中心词")));
});

test("search: 最长连续命中与中心词提取", () => {
  assert.equal(longestContiguous("四个层级的工作边界", "讲清 Agent 的四层工作边界"), 4);
  assert.equal(longestContiguous("魔圆", "魔圆同人游戏"), 2);
  assert.equal(longestContiguous("abc", "无关标题"), 0);
  assert.equal(focusPhrase("四个层级的工作边界"), "工作边界");
  assert.equal(focusPhrase("那个讲四层工作边界的视频"), "");
});

test("feed: 兴趣模型保留口味词，过滤通用词", () => {
  const titles = [
    "观星仪的表情包插件", "观星仪接入QQ", "观星仪记忆插件", "观星仪人格卡", "观星仪教程",
    "魔圆同人游戏试做", "魔圆解析", "魔圆的音乐", "魔圆手书", "魔圆补完计划",
  ];
  const filler = Array.from({ length: 40 }, (_, i) => ({ bvid: `BV1fffff${String(i).padStart(3, "0")}`, title: `某个无关视频第${i}期`, favTime: 1780000000 - i }));
  const favs = { videos: [...titles.map((t, i) => ({ bvid: `BV1ddddddd${i}`, title: t, favTime: 1790000000 - i })), ...filler] };
  const model = buildInterestModel(favs, { recentDays: 0 });
  assert.ok(model.weights.has("观星仪"));
  assert.ok(model.weights.has("魔圆"));
  assert.ok(!model.weights.has("视频"), "通用词不该进模型");
  assert.ok(!model.weights.has("看看"), "通用词不该进模型");
});

test("feed: 相关标题比大流量无关标题得分高", () => {
  const favs = { videos: [
    ...Array.from({ length: 8 }, (_, i) => ({ bvid: `BV1eeeeee${i}`, title: `观星仪插件第${i}期`, favTime: 1790000000 })),
    ...Array.from({ length: 40 }, (_, i) => ({ bvid: `BV1fffff${String(i).padStart(3, "0")}`, title: `某个无关视频第${i}期`, favTime: 1780000000 })),
  ] };
  const model = buildInterestModel(favs, { recentDays: 0 });
  const related = { title: "观星仪凭什么突然火了", play: 20000, favorites: 300, pubdate: Date.now(), durationSec: 300 };
  const hotNoise = { title: "百万播放的明星八卦大合集", play: 5000000, favorites: 90000, pubdate: Date.now(), durationSec: 300 };
  assert.ok(scoreFeedItem(related, model, { days: 30 }).score > scoreFeedItem(hotNoise, model, { days: 30 }).score);
  assert.ok(matchPhrases(related.title, model).score > 0, "相关标题必须命中兴趣词");
});



test("feed: rcmd 推荐流过滤广告卡并把时间转成毫秒", async () => {
  const fakeApi = {
    calls: 0,
    async request(url, q) {
      this.calls++;
      assert.match(String(url), /feed\/rcmd/);
      assert.equal(q.fresh_idx, 1);
      return { item: [
        { id: 1, bvid: "", title: "广告卡", cid: 0 },
        { id: 2, bvid: "BV1ggggggg1", title: "木工基础：打磨示例", duration: 661, pubdate: 1794542514,
          owner: { mid: 1, name: "示例作者C" }, stat: { view: 6174, like: 444, danmaku: 88 } },
      ] };
    },
  };
  const items = await rcmdFeed(fakeApi, { ps: 8, freshIdx: 1 });
  assert.equal(items.length, 1, "没有 bvid 的广告卡必须丢掉");
  const v = items[0];
  assert.equal(v.bvid, "BV1ggggggg1");
  assert.equal(v.pubdate, 1794542514 * 1000);
  assert.deepEqual(v.routes, ["推荐流"]);
  assert.equal(v.favorites, 0, "rcmd 不给收藏数，不能瞎补");
});

test("feed: 推荐流加成能把同等兴趣的条目顶上去", () => {
  const favs = { videos: Array.from({ length: 20 }, (_, i) => ({ bvid: `BV1fffff${i}`, title: `塔露拉同人第${i}期`, favTime: 1790000000 })) };
  const model = buildInterestModel(favs, { recentDays: 0 });
  const item = { title: "塔露拉的一天", play: 1000, favorites: 0, pubdate: Date.now(), durationSec: 300 };
  const plain = scoreFeedItem(item, model, {});
  const boosted = scoreFeedItem(item, model, { boost: 0.8 });
  assert.ok(boosted.score > plain.score);
  assert.ok(boosted.reasons.includes("B站推荐流"));
});
