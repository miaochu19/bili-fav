#!/usr/bin/env node
// 收藏夹采集 CLI：doctor / login / auth / list / fetch / stats
import { readFile } from "node:fs/promises";
import { existsSync, openSync, closeSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { FILES, TOOLS, BILI_WATCH, VAULT, DATA, ensureDirs, rel } from "../lib/paths.mjs";
import { loadCookies, parseCookieString, saveCookies, hasLogin, redact, cookieHeader } from "../lib/cookies.mjs";
import { readJson, writeJsonAtomic } from "../lib/fsx.mjs";
import { BiliApi, BiliError, NotLoggedInError } from "../lib/api.mjs";
import { knownInFolder, mediaKey, mergeFolder } from "../lib/favorites.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0] || "help";
const rest = argv.slice(1);

function flag(name, fallback = undefined) {
  const i = rest.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = rest[i + 1];
  return next && !next.startsWith("--") ? next : true;
}
const has = (name) => rest.includes(`--${name}`);

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c("2"), bold = c("1"), green = c("32"), yellow = c("33"), red = c("31"), cyan = c("36");

function fmtDuration(sec) {
  if (!sec && sec !== 0) return "?";
  const s = Number(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = Math.floor(s % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}
function fmtDate(unix) {
  if (!unix) return "?";
  const d = new Date(Number(unix) * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtInt(n) {
  return Number(n || 0).toLocaleString("zh-CN");
}

async function openApi({ credPath } = {}) {
  const { cookies, source } = await loadCookies({ credPath });
  const api = new BiliApi({
    cookies,
    log: (m) => console.log(dim(m)),
  });
  await api.init();
  return { api, cookies, source };
}

// ---------------------------------------------------------------- doctor
/**
 * 版本探测。不用管道捕获输出 —— 沙箱里 Node 的子进程管道会 EPERM，
 * 所以把 stdout/stderr 重定向到临时文件再读。
 */
function probe(bin, args = ["--version"]) {
  ensureDirs();
  const outFile = join(DATA, "logs", `.probe-${process.pid}-${Math.random().toString(16).slice(2, 8)}.txt`);
  let fd = null;
  try {
    fd = openSync(outFile, "w");
    const isScript = /\.(cmd|bat)$/i.test(bin);
    const r = isScript
      ? spawnSync("cmd.exe", ["/c", bin, ...args], { stdio: ["ignore", fd, fd], timeout: 30000 })
      : spawnSync(bin, args, { stdio: ["ignore", fd, fd], timeout: 30000 });
    if (fd !== null) { closeSync(fd); fd = null; }
    let out = "";
    try { out = readFileSync(outFile, "utf8").trim().split(/\r?\n/)[0] || ""; } catch { /* ignore */ }
    return { ok: (r.status ?? 1) === 0, out: out || r.error?.message || `exit ${r.status}` };
  } catch (err) {
    return { ok: false, out: err.message };
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
    try { rmSync(outFile, { force: true }); } catch { /* ignore */ }
  }
}

async function doctor() {
  ensureDirs();
  const rows = [];
  rows.push(["node", process.version, true]);

  const py = probe("python", ["--version"]);
  rows.push(["python", py.out || "缺失", py.ok]);

  const ytdlpCmd = join(TOOLS, "yt-dlp.cmd");
  let ytdlp = { ok: false, out: "缺失（tools/yt-dlp.cmd）" };
  if (existsSync(ytdlpCmd)) ytdlp = probe(ytdlpCmd);
  rows.push(["yt-dlp", ytdlp.out, ytdlp.ok]);

  const ffmpegExe = join(TOOLS, "ffmpeg.exe");
  let ffmpeg = { ok: false, out: "缺失（tools/ffmpeg.exe）" };
  if (existsSync(ffmpegExe)) ffmpeg = probe(ffmpegExe, ["-hide_banner", "-version"]);
  rows.push(["ffmpeg", ffmpeg.out, ffmpeg.ok]);

  const look = join(BILI_WATCH, "tools", "look.mjs");
  rows.push(["bili-watch", existsSync(look) ? rel(look) : "未 clone（vendor/bili-watch）", existsSync(look)]);

  const { cookies, source } = await loadCookies({ credPath: flag("cred") });
  rows.push(["cookie", cookies ? `${source} · ${JSON.stringify(redact(cookies))}` : "未配置", Boolean(cookies)]);
  rows.push(["登录态", hasLogin(cookies) ? "有 SESSDATA" : "匿名（只能读公开内容）", hasLogin(cookies)]);

  const api = new BiliApi({ cookies, log: () => {} });
  let who = null;
  let spiOk = false;
  try {
    await api.ensureBuvid();
    spiOk = true;
    who = await api.whoami();
  } catch (err) {
    rows.push(["B站 API", `不可达：${err.message}`, false]);
  }
  if (spiOk) rows.push(["B站 API", who ? `已登录：${who.uname} (${who.mid})` : "可达 · 匿名", true]);

  const width = Math.max(...rows.map((r) => r[0].length));
  console.log(bold("\n环境体检\n"));
  for (const [k, v, ok] of rows) {
    const mark = ok ? green("✓") : yellow("!");
    console.log(`  ${mark} ${k.padEnd(width)}  ${dim(String(v).slice(0, 110))}`);
  }
  const bad = rows.filter((r) => !r[2]).length;
  console.log(
    bad === 0
      ? green("\n全部就绪。\n")
      : `\n${yellow(`${bad} 项待处理`)}：缺依赖跑 scripts\\bootstrap.ps1；缺 Cookie 跑 node cli\\fav.mjs login\n`
  );
}

// ---------------------------------------------------------------- login
async function login() {
  ensureDirs();
  let text = "";
  const inline = flag("cookie");
  if (typeof inline === "string") {
    text = inline;
  } else if (!process.stdin.isTTY) {
    text = await readStdin();
  } else {
    console.log(bold("\n从浏览器取 Cookie\n"));
    console.log("  1. 浏览器登录 bilibili.com");
    console.log("  2. F12 → Application（应用）→ Cookies → https://www.bilibili.com");
    console.log(`  3. 复制这四行的值：${cyan("SESSDATA")} / ${cyan("bili_jct")} / ${cyan("DedeUserID")} / ${cyan("buvid3")}`);
    console.log("     （SESSDATA 是 HttpOnly，document.cookie 读不到，必须从 DevTools 复制）");
    console.log("  4. 粘成一行，例如：");
    console.log(dim("     SESSDATA=abc...; bili_jct=def...; DedeUserID=123456; buvid3=XYZ...\n"));
    console.log("  粘贴后回车（Esc 取消）：");
    text = await readStdin();
  }

  const cookies = parseCookieString(text);
  if (!Object.keys(cookies).length) {
    console.error(red("没解析到任何 Cookie。至少要 SESSDATA。"));
    process.exitCode = 1;
    return;
  }
  if (!cookies.SESSDATA) {
    console.error(red("缺 SESSDATA —— 没有它读不了私密收藏夹。"));
    process.exitCode = 1;
    return;
  }

  const api = new BiliApi({ cookies, log: () => {} });
  try {
    await api.ensureBuvid();
    const who = await api.whoami();
    if (!who) {
      console.error(red("Cookie 无效或已过期（B 站返回未登录）。请重新复制。"));
      process.exitCode = 1;
      return;
    }
    if (!cookies.buvid3) cookies.buvid3 = api.cookies.buvid3;
    if (!cookies.buvid4) cookies.buvid4 = api.cookies.buvid4;
    await saveCookies(cookies);
    console.log(green(`\n✓ 已保存 ${rel(FILES.cookies)}（0600）`));
    console.log(`  账号：${bold(who.uname)} (${who.mid})`);
  } catch (err) {
    console.error(red(`验证失败：${err.message}`));
    process.exitCode = 1;
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.resume();
  });
}

// ---------------------------------------------------------------- auth / list
async function auth() {
  const { api, cookies, source } = await openApi({ credPath: flag("cred") });
  const who = await api.whoami();
  if (!who) {
    console.log(yellow(`未登录（Cookie 来源：${source}）`));
    console.log(dim("  跑 node cli\\fav.mjs login 配置。"));
    process.exitCode = 1;
    return;
  }
  console.log(`${green("✓")} ${bold(who.uname)}  mid=${who.mid}  Lv${who.level ?? "?"}  大会员=${who.vip ? "是" : "否"}`);
  console.log(dim(`  Cookie：${source} · ${JSON.stringify(redact(cookies))}`));
}

async function list() {
  const { api } = await openApi({ credPath: flag("cred") });
  const who = await api.whoami();
  if (!who) {
    console.error(red("需要登录才能列出自己的收藏夹。先跑 login。"));
    process.exitCode = 1;
    return;
  }
  const folders = await api.myFolders(who.mid);
  if (has("json")) {
    console.log(JSON.stringify({ who, folders }, null, 2));
    return;
  }
  console.log(`\n${bold(who.uname)} 的收藏夹（${folders.length} 个）\n`);
  let total = 0;
  for (const f of folders) {
    total += f.count || 0;
    console.log(`  ${String(f.id).padEnd(12)} ${pad(f.title, 24)} ${dim(`${fmtInt(f.count)} 个`)}`);
  }
  console.log(`\n  合计 ${bold(fmtInt(total))} 条（含重复收藏）\n`);
}

function pad(s, n) {
  const str = String(s);
  let w = 0;
  for (const ch of str) w += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
  return str + " ".repeat(Math.max(0, n - w));
}

// ---------------------------------------------------------------- fetch
async function fetchAll() {
  ensureDirs();
  const { api } = await openApi({ credPath: flag("cred") });
  const who = await api.whoami();
  if (!who) {
    console.error(red("需要登录才能读取收藏夹。先跑 login。"));
    process.exitCode = 1;
    return;
  }

  const all = await api.myFolders(who.mid);
  const only = flag("folder");
  const targets = only
    ? all.filter((f) => String(f.id) === String(only) || f.title === only)
    : has("all") || rest.length === 0
      ? all
      : [];
  if (!targets.length) {
    console.error(red(`没选中任何收藏夹（--folder ${only ?? "未给"}）`));
    process.exitCode = 1;
    return;
  }

  console.log(`\n${bold("抓取")} ${who.uname} · ${targets.length} 个收藏夹${has("incremental") ? dim("（增量）") : ""}\n`);
  const prev = await readJson(FILES.favs, null);
  if (prev?.mid && String(prev.mid) !== String(who.mid)) throw new Error("已有收藏属于另一账号，请先备份并移走 data/favs.json，避免混合账号数据");
  const incremental = has("incremental");

  const byBvid = new Map();
  // 增量 / 只抓单个收藏夹时，先保留已有数据，避免把没抓的部分删掉
  if (prev?.videos) {
    for (const v of prev.videos) byBvid.set(mediaKey(v), structuredClone(v));
  }

  const folderStats = [];
  for (const folder of targets) {
    const known = knownInFolder(prev?.videos || [], folder.id);
    process.stdout.write(`  ${pad(folder.title, 22)} ${dim(`${fmtInt(folder.count)} 个`)} … `);
    let pages = 0;
    let got = 0;
    let fresh = 0;
    let stoppedEarly = false;
    try {
      const res = await api.favAll(folder.id, {
        onPage: ({ total, pn }) => {
          pages = pn;
          got = total;
        },
        shouldStop: (page) => {
          if (!incremental || known.size === 0) return false;
          const newOnPage = page.medias.filter((m) => !known.has(mediaKey(m))).length;
          fresh += newOnPage;
          if (newOnPage === 0) {
            stoppedEarly = true;
            return true;
          }
          return false;
        },
      });
      mergeFolder(byBvid, res.medias, folder, { complete: !stoppedEarly });
      folderStats.push({ id: folder.id, title: folder.title, declared: folder.count, fetched: res.medias.length, pages });
      console.log(
        green(`✓ ${fmtInt(res.medias.length)} 个 / ${pages} 页`) +
          (stoppedEarly ? dim(`（增量：${fresh} 个新的，提前收手）`) : "")
      );
    } catch (err) {
      folderStats.push({ id: folder.id, title: folder.title, declared: folder.count, fetched: got, pages, error: err.message });
      console.log(red(`✗ ${err.message}`));
      process.exitCode = 1;
      if (err instanceof NotLoggedInError) break;
      if (err.name === "RiskControlError") {
        console.log(yellow("  风控。已保存已完成部分，稍后再跑一次会覆盖合并。"));
        break;
      }
    }
  }

  // 没抓的收藏夹沿用上次的统计行
  if (prev?.folders) {
    for (const f of prev.folders) {
      if (!folderStats.some((x) => x.id === f.id)) folderStats.push(f);
    }
  }

  const videos = [...byBvid.values()];
  const now = Date.now();
  const payload = {
    generatedAt: new Date(now).toISOString(),
    mid: who.mid,
    uname: who.uname,
    folders: folderStats,
    videos,
  };
  await writeJsonAtomic(FILES.favs, payload);

  const totalDur = videos.reduce((s, v) => s + (v.duration || 0), 0);
  console.log(
    `\n${green("✓")} 写入 ${rel(FILES.favs)}：${bold(fmtInt(videos.length))} 个唯一视频，` +
      `合计 ${bold((totalDur / 3600).toFixed(1))} 小时`
  );
  const invalid = videos.filter((v) => v.invalid).length;
  if (invalid) console.log(yellow(`  其中 ${invalid} 个是失效/异常条目，已标记 invalid`));
  console.log(dim(`  下一步：node cli\\fav.mjs stats\n`));
}

// ---------------------------------------------------------------- stats
async function stats() {
  const data = await readJson(FILES.favs, null);
  if (!data) {
    console.error(red("还没有 data/favs.json，先跑 node cli\\fav.mjs fetch --all"));
    process.exitCode = 1;
    return;
  }
  const videos = data.videos || [];
  const valid = videos.filter((v) => !v.invalid);
  const totalDur = valid.reduce((s, v) => s + (v.duration || 0), 0);

  const byFolder = new Map();
  const byYear = new Map();
  const byUp = new Map();
  for (const v of valid) {
    for (const f of v.folders || []) {
      const k = f.title;
      byFolder.set(k, (byFolder.get(k) || 0) + 1);
    }
    if (v.pubtime) {
      const y = new Date(v.pubtime * 1000).getFullYear();
      byYear.set(y, (byYear.get(y) || 0) + 1);
    }
    if (v.up) byUp.set(v.up, (byUp.get(v.up) || 0) + 1);
  }

  if (has("json")) {
    console.log(
      JSON.stringify(
        {
          generatedAt: data.generatedAt,
          uname: data.uname,
          total: videos.length,
          valid: valid.length,
          invalid: videos.length - valid.length,
          hours: +(totalDur / 3600).toFixed(2),
          byFolder: Object.fromEntries(byFolder),
          byYear: Object.fromEntries([...byYear].sort((a, b) => a[0] - b[0])),
          topUps: [...byUp].sort((a, b) => b[1] - a[1]).slice(0, 15),
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`\n${bold("收藏夹总览")}  ${dim(`抓取于 ${data.generatedAt}`)}\n`);
  console.log(`  账号        ${data.uname} (${data.mid})`);
  console.log(`  唯一视频    ${bold(fmtInt(videos.length))}`);
  console.log(`  有效 / 失效 ${fmtInt(valid.length)} / ${fmtInt(videos.length - valid.length)}`);
  console.log(`  总时长      ${bold((totalDur / 3600).toFixed(1))} 小时（${(totalDur / 86400).toFixed(1)} 天）`);
  if (valid.length) {
    const avg = totalDur / valid.length / 60;
    console.log(`  平均时长    ${avg.toFixed(1)} 分钟`);
  }

  const bar = (n, max) => "█".repeat(Math.max(1, Math.round((n / max) * 24)));

  const folders = [...byFolder].sort((a, b) => b[1] - a[1]);
  if (folders.length) {
    console.log(`\n${bold("按收藏夹")}`);
    const max = folders[0][1];
    for (const [name, n] of folders) console.log(`  ${pad(name, 22)} ${String(n).padStart(5)}  ${dim(bar(n, max))}`);
  }

  const years = [...byYear].sort((a, b) => a[0] - b[0]);
  if (years.length) {
    console.log(`\n${bold("按发布年份")}`);
    const max = Math.max(...years.map((y) => y[1]));
    for (const [y, n] of years) console.log(`  ${y}  ${String(n).padStart(5)}  ${dim(bar(n, max))}`);
  }

  const ups = [...byUp].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (ups.length) {
    console.log(`\n${bold("收藏最多的 UP 主")}`);
    const max = ups[0][1];
    for (const [u, n] of ups) console.log(`  ${pad(u, 22)} ${String(n).padStart(5)}  ${dim(bar(n, max))}`);
  }
  console.log(`\n  产出目录：${rel(VAULT)}\n`);
}

// ---------------------------------------------------------------- main
const HELP = `
${bold("bili-fav")} —— B 站收藏夹采集

  node cli/fav.mjs doctor            体检（依赖 / Cookie / 登录态 / API）
  node cli/fav.mjs login             粘贴 Cookie 并验证保存
  node cli/fav.mjs auth              看当前登录账号
  node cli/fav.mjs list [--json]     列出收藏夹与数量
  node cli/fav.mjs fetch --all       全量抓取 → data/favs.json
  node cli/fav.mjs fetch --all --incremental  只抓新增（按收藏时间倒序，提前收手）
  node cli/fav.mjs fetch --folder 123 只抓一个收藏夹
  node cli/fav.mjs stats [--json]    统计：总数 / 时长 / 年份 / UP

  公共参数：--cred <cookies.json|.txt>  指定 Cookie 文件
`;

try {
  switch (cmd) {
    case "doctor": await doctor(); break;
    case "login": await login(); break;
    case "auth": await auth(); break;
    case "list": await list(); break;
    case "fetch": case "fetch-all": await fetchAll(); break;
    case "stats": await stats(); break;
    case "help": case "--help": case "-h": console.log(HELP); break;
    default:
      console.error(red(`未知命令：${cmd}`));
      console.log(HELP);
      process.exitCode = 2;
  }
} catch (err) {
  if (err instanceof BiliError) {
    console.error(red(`\n${err.message}`));
    if (err.name === "RiskControlError") console.error(dim("  风控通常 10–30 分钟后解除；别连续重试。"));
  } else {
    console.error(red(`\n${err.stack || err.message}`));
  }
  process.exitCode = 1;
}
