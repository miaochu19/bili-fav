#!/usr/bin/env node
// 批量准备素材：按工作清单逐个 pack，带断点与风控熔断
import { join } from "node:path";

import { FILES, DATA, ensureDirs, rel } from "../lib/paths.mjs";
import { readJson, writeJsonAtomic, sleep } from "../lib/fsx.mjs";
import { loadCookies } from "../lib/cookies.mjs";
import { BiliApi, RiskControlError, NotLoggedInError } from "../lib/api.mjs";
import { buildPacket, buildWorklist, estimateCost } from "../lib/pack.mjs";
import { fmtClock } from "../lib/media.mjs";
import { cleanState } from "../lib/state.mjs";

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

async function touchState(bvid, patch) {
  const state = (await readJson(FILES.state, {})) || {};
  const notes = (await readJson(FILES.notes, {})) || {};
  if (notes[bvid] && patch.status === "packed") patch = { ...patch, status: "written", note: notes[bvid].path };
  state[bvid] = { ...(state[bvid] || {}), ...patch, at: new Date().toISOString() };
  await writeJsonAtomic(FILES.state, state);
}

async function cleanup() {
  const state = (await readJson(FILES.state, {})) || {};
  const favs = await readJson(FILES.favs, null), notes = (await readJson(FILES.notes, {})) || {};
  if (!favs) throw new Error("没有收藏数据，无法判断哪些状态过期");
  const result = cleanState(state, { favs, notes });
  console.log(`移除 ${result.removed.length} 条收藏/笔记之外的状态，修复 ${result.repaired.length} 条已写笔记状态`);
  if (result.removed.length) console.log(result.removed.join("\n"));
  if (!rest.includes("--apply")) { console.log("预览；加 --apply 写入（自动备份旧 state）"); return; }
  if (result.removed.length || result.repaired.length) {
    await writeJsonAtomic(`${FILES.state}.${Date.now()}.bak`, state);
    await writeJsonAtomic(FILES.state, result.state);
  }
}

async function packBatch() {
  ensureDirs();
  const { cookies } = await loadCookies({ credPath: flag("cred") });
  const api = new BiliApi({ cookies, log: (m) => console.log(dim(m)) });
  await api.init();

  const { favs, pending } = await buildWorklist();
  if (!favs) { console.error(red("没有 data/favs.json，先 node cli/fav.mjs fetch --all")); process.exitCode = 1; return; }

  const n = Number(flag("n", 5));
  const folder = flag("folder");
  const topic = flag("topic");
  const maxMin = Number(flag("max-minutes", 0));
  const minMin = Number(flag("min-minutes", 0));
  // 批量也能要更多评论：默认仍 5 条，--comments 200 / all 会按 置顶→UP→点赞 抓。
  const commentArg = flag("comments", "5");
  const comments = typeof commentArg === "string" && /^(all|全部|-1|\*)$/i.test(commentArg.trim()) ? Infinity : Number(commentArg);
  if (commentArg === true || !(comments === Infinity || Number.isInteger(comments) && comments >= 0 && comments <= 1000))
    throw new Error("--comments 必须是 0–1000 或 all");
  const commentsMode = String(flag("comments-mode", "all"));
  if (!["hot", "time", "all"].includes(commentsMode)) throw new Error("--comments-mode 必须是 hot / time / all");

  let list = pending;
  if (typeof folder === "string") list = list.filter((v) => v.folders?.some((f) => f.title === folder || String(f.id) === folder));
  if (typeof topic === "string") {
    const topicMap = (await readJson(join(DATA, "topics.json"), null))?.assign || {};
    list = list.filter((v) => topicMap[v.bvid] === topic);
  }
  if (maxMin > 0) list = list.filter((v) => (v.duration || 0) <= maxMin * 60);
  if (minMin > 0) list = list.filter((v) => (v.duration || 0) >= minMin * 60);
  list = list.slice(0, n);

  if (!list.length) { console.log(yellow("没有需要处理的视频。")); return; }

  if (rest.includes("--dry")) {
    console.log(`\n${bold("选中")} ${list.length} 个（dry run，不下载）\n`);
    for (const v of list) console.log(`  ${fmtClock(v.duration).padStart(7)}  ${v.bvid}  ${v.title.slice(0, 50)}`);
    return;
  }

  console.log(`\n${bold("批量准备")} ${list.length} 个（队列里还有 ${pending.length}）\n`);
  let ok = 0, fail = 0, stopped = null;

  for (const [i, v] of list.entries()) {
    const e = estimateCost(v);
    process.stdout.write(`  [${i + 1}/${list.length}] ${v.title.slice(0, 40).padEnd(40)} ${fmtClock(v.duration).padStart(7)} … `);
    try {
      const packet = await buildPacket(api, v.bvid, {
        favs,
        asr: rest.includes("--asr"),
        asrModel: flag("model"),
        maxAsrMinutes: Number(flag("max-asr-minutes", 60)),
        comments,
        commentsMode,
      });
      const hasSub = Boolean(packet.materials.transcript);
      const hasSheets = packet.materials.sheets.length > 0;
      await touchState(v.bvid, {
        status: "packed",
        title: v.title,
        subtitle: hasSub ? packet.materials.subtitleLang : null,
        sheets: packet.materials.sheets.length,
        duration: v.duration,
      });
      ok++;
      const flags = [hasSub ? green("字幕") : yellow("无字幕"), hasSheets ? `${packet.materials.sheets.length}图` : "无图"];
      console.log(flags.join(" · "));
      if (!hasSheets) console.log(dim(`      需要画面：node cli/video.mjs sheet ${v.bvid} --step 5`));
    } catch (err) {
      fail++;
      console.log(red(err.message.slice(0, 90)));
      await touchState(v.bvid, { status: "failed", title: v.title, error: err.message.slice(0, 300) });
      if (err instanceof NotLoggedInError) { stopped = "Cookie 失效"; break; }
      if (err instanceof RiskControlError) { stopped = "触发风控"; break; }
    }
    // 视频之间留一点间隔，别把收藏夹当靶子
    if (i < list.length - 1) await sleep(1200 + Math.random() * 1800);
  }

  console.log(`\n  完成 ${green(String(ok))}　失败 ${fail ? red(String(fail)) : 0}${stopped ? `　${yellow(`已停止：${stopped}`)}` : ""}`);
  console.log(dim(`  下一步：node cli/note.mjs plan　然后逐个写正文\n`));
}

async function status() {
  const { favs, pending, done } = await buildWorklist();
  const state = (await readJson(FILES.state, {})) || {};
  const byStatus = {};
  for (const v of Object.values(state)) byStatus[v.status] = (byStatus[v.status] || 0) + 1;

  console.log(`\n${bold("进度")}`);
  if (!favs) { console.log(red("  还没有抓取收藏夹。")); return; }
  console.log(`  收藏夹      ${favs.videos.length} 个（${(favs.videos.reduce((s, v) => s + (v.duration || 0), 0) / 3600).toFixed(1)} 小时）`);
  console.log(`  已写笔记    ${done.length}`);
  console.log(`  待处理      ${pending.length}`);
  console.log(`  状态分布    ${Object.entries(byStatus).map(([k, n]) => `${k}=${n}`).join("  ") || "—"}`);
  console.log();
}

async function main() {
  ensureDirs();
  switch (cmd) {
    case "pack": await packBatch(); break;
    case "status": await status(); break;
    case "clean-state": await cleanup(); break;
    default:
      console.log(`
${bold("bili-fav batch")}

  node cli/batch.mjs pack [--n 5] [--folder 名称] [--max-minutes 60] [--asr]
                           [--comments 5|0-1000|all] [--comments-mode hot|time|all]
  node cli/batch.mjs status
  node cli/batch.mjs clean-state [--apply]  清理收藏/笔记外状态并修复已写状态，默认预览
`);
  }
}

main().catch((err) => {
  console.error(red(`\n${err.stack || err.message}`));
  process.exitCode = 1;
});
