#!/usr/bin/env node
// 主题聚类：只用标题（+UP/时长），不下载视频，产出主题地图
import { join } from "node:path";

import { FILES, DATA, VAULT, ensureDirs, rel } from "../lib/paths.mjs";
import { readJson, writeJsonAtomic, writeTextAtomic } from "../lib/fsx.mjs";
import { fmtClock } from "../lib/media.mjs";
import { mkdir } from "node:fs/promises";
import { validateModelAssignments } from "../lib/topics.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0] || "build";
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

/** 主题规则：命中标题里的关键词即归入。靠前的规则优先。 */
const DEFAULT_RULES = [
  { name: "东方Project", kw: ["东方", "幻想乡", "灵梦", "魔理沙", "东方project", "touhou", "妖梦", "咲夜", "八云"] },
  { name: "赛马娘", kw: ["赛马娘", "马娘", "ウマ娘", "草上飞", "特别周", "东海帝王", "目白"] },
  { name: "明日方舟", kw: ["明日方舟", "方舟", "罗德岛", "干员", "博士", "整合运动", "阿米娅", "蕾克"] },
  { name: "二次元/同人", kw: ["魔法少女", "小圆", "圆神", "晓美焰", "巴麻美", "碧蓝档案", "蔚蓝档案", "undertale", "初音", "偶像", "同人", "二创", "小圆", "沙耶加", "杏子", "魔女"] },
  { name: "钢铁雄心/战棋", kw: ["钢铁雄心", "hoi4", "钢4", "kr", "kx", "战棋", "mod", "模组", "tno", "千禧", "英式和平"] },
  { name: "AI/大模型", kw: ["大模型", "deepseek", "gpt", "llm", "ai", "智能体", "agent", "推理引擎", "vllm", "微调", "提示词", "deepinfer", "transformer", "扩散模型"] },
  { name: "编程/技术", kw: ["编程", "代码", "python", "java", "前端", "后端", "算法", "linux", "docker", "git", "数据库", "架构", "开源"] },
  { name: "数码评测", kw: ["手机", "显卡", "cpu", "芯片", "评测", "开箱", "笔记本", "平板", "耳机", "屏幕", "骁龙", "天玑"] },
  { name: "游戏", kw: ["游戏", "实况", "攻略", "速通", "我的世界", "泰拉", "星露谷", "p社", "文明", "独立游戏", "潜渊症", "雪原列车", "原神", "崩坏", "实机演示", "试玩"] },
  { name: "音乐/音频", kw: ["音乐", "翻唱", "演奏", "mmd", "bgm", "歌", "乐器", "钢琴", "吉他", "交响", "ost", "小曲", "合唱", "军歌", "纯享"] },
  { name: "动画/鬼畜", kw: ["动画", "番剧", "鬼畜", "mad", "amv", "漫画", "剪辑", "混剪", "预告", "梗", "万恶之源", "生草", "抽象", "meme", "沙雕"] },
  { name: "绘画/美术", kw: ["画法", "绘画", "画师", "板绘", "插画", "素描", "上色", "人体", "构图", "动漫教程"] },
  { name: "历史/人文", kw: ["历史", "苏联", "文学", "哲学", "政治", "经济", "战争", "革命", "考古", "社会", "文化", "鲁迅", "毛选", "孔庆东"] },
  { name: "军事/时政", kw: ["军事", "红军", "纳粹", "时政", "核污水", "评论", "国际", "美国", "印度", "日本", "地缘"] },
  { name: "科学/科普", kw: ["科普", "数学", "物理", "化学", "生物", "天文", "地质", "医学", "工程", "宇宙", "行星"] },
  { name: "学习/课程", kw: ["教程", "课程", "讲解", "入门", "考研", "高考", "英语", "学习"] },
  { name: "影视/特摄", kw: ["电影", "电视剧", "解说", "影评", "纪录片", "综艺", "特摄", "假面骑士", "奥特曼"] },
  { name: "生活/美食", kw: ["美食", "做饭", "旅行", "vlog", "日常", "探店", "健身", "菜", "便当", "便利店", "关东煮"] },
  { name: "猫/宠物", kw: ["猫", "狗", "宠物", "喵", "汪"] },
  { name: "ASMR/助眠", kw: ["耳かき", "囁き", "asmr", "助眠", "睡眠", "低音"] },
];

async function loadRules() {
  const custom = await readJson(join(DATA, "topics.rules.json"), null);
  return custom?.rules?.length ? custom.rules : DEFAULT_RULES;
}

function classify(video, rules) {
  const text = `${video.title || ""} ${video.up || ""} ${video.intro || ""}`.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const rule of rules) {
    let score = 0;
    for (const k of rule.kw) {
      const needle = k.toLowerCase();
      // 短英文词（ai/llm/gpt/kr/mod…）必须词边界匹配，否则 "Chiang Kai-shek" 会被当成 AI
      if (/^[a-z0-9]{1,4}$/.test(needle)) {
        const re = new RegExp(`(^|[^a-z0-9])${needle}($|[^a-z0-9])`, "i");
        if (re.test(text)) score += 3;
      } else if (text.includes(needle)) {
        score += Math.max(1, [...k].length);
      }
    }
    if (score > bestScore) { bestScore = score; best = rule.name; }
  }
  return { topic: best || "未分类", score: bestScore };
}

async function build() {
  const favs = await readJson(FILES.favs, null);
  if (!favs) { console.error(red("没有 data/favs.json，先 fetch")); process.exit(1); }
  const rules = await loadRules();
  const videos = (favs.videos || []).filter((v) => !v.invalid);
  const modelFile = join(DATA, "topics.model.json");
  let overrides = (await readJson(modelFile, { assign: {} })).assign || {};
  const modelInput = flag("from-model");
  if (modelInput !== undefined) {
    if (typeof modelInput !== "string") throw new Error("--from-model 后需要 JSON 文件路径");
    const input = await readJson(modelInput, null);
    overrides = { ...overrides, ...validateModelAssignments(input, videos, rules) };
    await writeJsonAtomic(modelFile, { generatedAt: new Date().toISOString(), assign: overrides });
  }

  const groups = new Map();
  const assign = {};
  for (const v of videos) {
    const topic = overrides[v.bvid] || classify(v, rules).topic;
    assign[v.bvid] = topic;
    if (!groups.has(topic)) groups.set(topic, []);
    groups.get(topic).push(v);
  }
  await writeJsonAtomic(join(DATA, "topics.json"), { generatedAt: new Date().toISOString(), assign });

  const rows = [...groups].map(([name, list]) => {
    const hours = list.reduce((s, v) => s + (v.duration || 0), 0) / 3600;
    const upCount = new Map();
    for (const v of list) upCount.set(v.up, (upCount.get(v.up) || 0) + 1);
    const topUps = [...upCount].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([u]) => u);
    return { name, count: list.length, hours, topUps, sample: list.slice(0, 3).map((v) => v.title) };
  }).sort((a, b) => b.count - a.count);

  const out = [
    "---", "type: topics", "title: 主题地图", `updated: ${new Date().toISOString().slice(0, 10)}`, "---", "",
    "# 主题地图", "",
    `共 ${videos.length} 个有效视频，按标题、UP、简介关键词及已导入的模型分类导航；模型覆盖 ${videos.filter((v) => overrides[v.bvid]).length} 条。`, "",
    "| 主题 | 视频数 | 时长 | 代表 UP | 示例 |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const r of rows) {
    const sample = r.sample.map((s) => s.replace(/\|/g, "\\|").slice(0, 26)).join("；");
    out.push(`| **${r.name}** | ${r.count} | ${r.hours.toFixed(1)}h | ${r.topUps.join("、")} | ${sample} |`);
  }
  out.push("");
  // 未分类里到底是谁：按 UP 聚合，帮用户判断要不要用「UP 主」这个维度
  const rest = groups.get("未分类") || [];
  if (rest.length) {
    const byUp = new Map();
    for (const v of rest) byUp.set(v.up || "(未知)", (byUp.get(v.up || "(未知)") || 0) + 1);
    const topUps = [...byUp].sort((a, b) => b[1] - a[1]).slice(0, 12);
    out.push("## 未分类里的头部 UP", "");
    for (const [u, n] of topUps) out.push(`- ${u}：${n} 个`);
    out.push("", `未分类共 ${rest.length} 个，平均时长 ${(rest.reduce((s, v) => s + (v.duration || 0), 0) / rest.length / 60).toFixed(1)} 分钟。`, "");
  }
  await writeTextAtomic(join(VAULT, "00-索引", "主题地图.md"), out.join("\n"));

  console.log(`\n${bold("主题地图")}　${videos.length} 个有效视频\n`);
  for (const r of rows) {
    console.log(`  ${String(r.count).padStart(5)}  ${r.hours.toFixed(1).padStart(6)}h  ${r.name}`);
  }
  console.log(`\n${green("✓")} ${rel(join(VAULT, "00-索引", "主题地图.md"))}`);
  console.log(dim(`  看某主题的成员：node cli/topics.mjs show 主题名\n`));
}

async function show() {
  const name = rest[0];
  if (!name) { console.error(red("用法：node cli/topics.mjs show <主题>")); process.exit(1); }
  const favs = await readJson(FILES.favs, null);
  const rules = await loadRules();
  const saved = await readJson(join(DATA, "topics.json"), null);
  const n = Number(flag("n", 30));
  const list = (favs?.videos || []).filter((v) => !v.invalid && (saved?.assign?.[v.bvid] || classify(v, rules).topic) === name);
  console.log(`\n${bold(name)}　${list.length} 个\n`);
  for (const v of list.slice().sort((a, b) => (b.favTime || 0) - (a.favTime || 0)).slice(0, n)) {
    const d = new Date((v.favTime || 0) * 1000).toISOString().slice(0, 10);
    console.log(`  ${d}  ${fmtClock(v.duration).padStart(7)}  ${v.bvid}  ${v.title.slice(0, 46)}`);
  }
}

async function prepare() {
  const favs = await readJson(FILES.favs, null), rules = await loadRules();
  if (!favs) throw new Error("没有 data/favs.json");
  const size = Number(flag("batch-size", 200));
  if (!Number.isInteger(size) || size < 1 || size > 1000) throw new Error("--batch-size 必须为 1–1000");
  const out = flag("out", join(DATA, "topic-batches"));
  if (typeof out !== "string") throw new Error("--out 需要目录路径");
  await mkdir(out, { recursive: true });
  const videos = favs.videos.filter((v) => !v.invalid);
  const topics = [...rules.map((r) => r.name), "未分类"];
  for (let i = 0; i < videos.length; i += size) {
    await writeJsonAtomic(join(out, `batch-${String(Math.floor(i / size) + 1).padStart(3, "0")}.json`), {
      instruction: "为每条视频选择且仅选择一个 allowedTopics 中的主题。不确定用未分类。返回 {assign: {bvid: topic}}，保留 BV 原样。",
      allowedTopics: topics, videos: videos.slice(i, i + size).map(({ bvid, title, up, intro }) => ({ bvid, title, up, intro })),
    });
  }
  console.log(`已导出 ${Math.ceil(videos.length / size)} 批 / ${videos.length} 条 → ${out}`);
}

async function main() {
  ensureDirs();
  switch (cmd) {
    case "build": await build(); break;
    case "show": await show(); break;
    case "prepare": await prepare(); break;
    default: console.log(`
${bold("bili-fav topics")}

  node cli/topics.mjs build          生成主题地图
  node cli/topics.mjs show 主题名     列出成员
  node cli/topics.mjs prepare        导出每批 200 条及受控词表
  node cli/topics.mjs build --from-model result.json  校验并导入模型分类，后续重建会保留
`);
  }
}

main().catch((err) => { console.error(red(`\n${err.stack || err.message}`)); process.exitCode = 1; });
