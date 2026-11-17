import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { API, RiskControlError } from "./api.mjs";
import { CACHE } from "./paths.mjs";
import { beforeRequest, trip } from "./traffic.mjs";
import { stopOnAccountError } from "./subtitle-quality.mjs";
import { parseDanmakuXml } from "./danmaku.mjs";
import { digest } from "./material-cache.mjs";

const REFERER = "https://www.bilibili.com/";

async function checkMaterialResponse(response, label) {
  if ([412, 429].includes(response.status)) {
    await response.body?.cancel();
    const minutes = await trip(`${label} HTTP ${response.status}`);
    throw new RiskControlError(`${label}触发 HTTP ${response.status}，暂停 ${minutes} 分钟`, { status: response.status });
  }
  if (!response.ok) throw new Error(`${label}失败 HTTP ${response.status}`);
}

/** 视频详情。优先 view/detail（本机实测 /view 被 412）。 */
export async function getView(api, bvid) {
  const d = await api.request(API.viewDetail, { bvid });
  const view = d?.View || null;
  if (view) {
    // 官方内容标注（如「含AI生成内容」）与 UP 粉丝数：判断可信度/搬运号的关键信号
    view.argue = view.argue_info?.argue_msg || null;
    view.fans = d?.Card?.fans ?? null;
    view.upSign = d?.Card?.sign || null;
  }
  return view;
}

/** Everything downstream operates on P1; keep the collection total separately. */
export function firstPartView(view, pages = []) {
  const first = pages[0];
  if (pages.length > 1 && !(Number(first?.duration) > 0)) throw new Error("多 P 视频缺少第一 P 时长，停止以免混用合集总时长");
  return { ...view, cid: first?.cid || view.cid, duration: first?.duration || view.duration,
    totalDuration: view.duration, multiPart: pages.length > 1, part: first?.part || null, page: 1, pageCount: pages.length || 1 };
}

/** 分 P 列表 → cid。 */
export async function getPages(api, bvid) {
  const list = await api.request(API.pagelist, { bvid });
  return (list || []).map((p) => ({
    cid: p.cid,
    page: p.page,
    part: p.part,
    duration: p.duration,
  }));
}

/**
 * 播放器信息：字幕轨、互动信息。
 * 必须先走 WBI 签名的 /x/player/wbi/v2：不带签名也能拿到 subtitle_url，但那个 URL
 * 缺 auth_key，CDN 会 403 或**返回别人的字幕**（实测同一视频三次 278/278/102 行）。
 */
export async function getPlayer(api, bvid, cid) {
  let d = null;
  let source = "wbi";
  let lastErr = null;
  const { signedQuery } = await import("./wbi.mjs");
  for (let i = 0; i < 2 && !d; i++) {
    try {
      const q = await signedQuery(api, { bvid, cid });
      d = await api.request(API.playerWbiV2, {}, { rawQuery: q });
    } catch (err) {
      stopOnAccountError(err);
      lastErr = err;
      d = null;
    }
  }
  if (!d?.subtitle) {
    // 只把 legacy 当"降级手段"，并且标出来——legacy 返回的 subtitle_url 没有 auth_key，
    // CDN 可能给 403 或别人的字幕，错轨检测要能看见这个 source。
    source = "legacy";
    try {
      d = await api.request(API.playerV2, { bvid, cid });
    } catch (err) {
      stopOnAccountError(err);
      throw lastErr || err;
    }
  }
  const subs = (d?.subtitle?.subtitles || []).map((s) => ({
    lan: s.lan,
    lanDoc: s.lan_doc,
    url: s.subtitle_url?.startsWith("//") ? `https:${s.subtitle_url}` : s.subtitle_url,
    ai: s.lan?.startsWith("ai-") || false,
  }));
  return { subtitles: subs, acceptQuality: d?.accept_quality || [], raw: d, source };
}

/** 字幕正文（B 站返回 body: [{from,to,content}]）。 */
export async function fetchSubtitle(api, subUrl) {
  await beforeRequest();
  const res = await fetch(subUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Referer: REFERER,
      Cookie: Object.entries(api.cookies || {})
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
    },
  });
  await checkMaterialResponse(res, "字幕下载");
  const json = await res.json();
  const body = json?.body || [];
  return body.map((b) => ({ from: b.from, to: b.to, text: b.content }));
}

/** 弹幕 XML → 时间桶峰值（每 30 秒一桶）。withText 时顺带解析正文，但峰值仍走原来的规则。 */
export async function getDanmakuPeaks(api, cid, { bucketSec = 30, withText = false, duration = null } = {}) {
  await beforeRequest();
  const res = await fetch(`${API.danmaku}?oid=${cid}`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Referer: REFERER,
      Cookie: Object.entries(api.cookies || {})
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
    },
  });
  await checkMaterialResponse(res, "弹幕拉取");
  const xml = await res.text();
  const buckets = new Map();
  let total = 0;
  const re = /<d p="([^"]+)">([\s\S]*?)<\/d>/g;
  let m;
  while ((m = re.exec(xml))) {
    const p = m[1].split(",");
    const t = Number(p[0]);
    if (!Number.isFinite(t)) continue;
    const k = Math.floor(t / bucketSec) * bucketSec;
    buckets.set(k, (buckets.get(k) || 0) + 1);
    total++;
  }
  const list = [...buckets].sort((a, b) => a[0] - b[0]).map(([sec, n]) => ({ sec, n }));
  const out = { total, bucketSec, peaks: list };
  if (withText) {
    // 严格解析失败只影响正文，不能顺手把已得到的峰值也作废。
    try { out.text = parseDanmakuXml(xml, { cid, duration, bucketSec }); }
    catch (err) { out.textError = err.message; }
    out.xmlBytes = Buffer.byteLength(xml);
    out.xmlSha256 = digest(xml);
  }
  return out;
}

/** 评论时间按本机时区展示；B 站给的是秒级 unix。 */
function commentTime(ctime) {
  const n = Number(ctime);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = new Date(n * 1000);
  const p = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 楼中楼预览最多带几条；再多就走 --replies 显式翻页。 */
const REPLY_PREVIEW = 3;

/**
 * 评论区单页（只读）。参考 dsh-bili-whale 的 comments.mjs：
 * - sort=2 是热度、sort=0 是时间；oid 要 aid 不是 BV；
 * - 置顶与 UP 置顶单独在 data.top / data.upper.top，不混进普通列表；
 * - 每条根评论内联的 replies 里常有 UP 的回复，顺手带上预览，省一次楼中楼请求；
 * - 这个接口匿名可读，带 cookie 能多看到"仅登录可见"的楼层。
 * upMid 用来标出"这条是 UP 自己发的"，是评论区优先级的第一档。
 */
export async function getComments(api, aid, { ps = 20, pn = 1, sort = "hot", maxChars = 200, upMid = null } = {}) {
  const d = await api.request(API.reply, {
    type: 1,
    oid: aid,
    pn,
    ps,
    sort: sort === "time" ? 0 : 2,
  });
  const up = upMid == null || upMid === "" ? null : String(upMid);
  const sub = (r) => ({
    rpid: String(r.rpid ?? ""),
    name: r.member?.uname ?? "匿名",
    mid: String(r.member?.mid ?? ""),
    isUp: up != null && String(r.member?.mid ?? "") === up,
    like: Number(r.like ?? 0),
    time: commentTime(r.ctime),
    text: String(r.content?.message ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
  });
  const one = (r, tag = null) => {
    const mid = String(r.member?.mid ?? r.mid ?? "");
    return {
      rpid: String(r.rpid ?? ""),
      name: r.member?.uname ?? "匿名",
      mid,
      isUp: up != null && mid === up,
      like: Number(r.like ?? 0),
      replies: Number(r.rcount ?? 0),
      time: commentTime(r.ctime),
      text: String(r.content?.message ?? "").replace(/\s+/g, " ").trim().slice(0, maxChars),
      // 评论可以带图（content.pictures）。每条最多留 4 张，后面按需下载。
      pics: (r.content?.pictures || [])
        .slice(0, 4)
        .map((p) => ({
          url: String(p.img_src || "").replace(/^\/\//, "https://").replace(/^http:\/\//, "https://"),
          w: Number(p.img_width || 0),
          h: Number(p.img_height || 0),
        }))
        .filter((p) => p.url),
      replyPreview: (Array.isArray(r.replies) ? r.replies : []).filter(Boolean).slice(0, REPLY_PREVIEW).map(sub),
      tag,
    };
  };
  const top = [
    ...(Array.isArray(d?.top) ? d.top.filter(Boolean).map((r) => one(r, "置顶")) : []),
    ...(d?.upper?.top ? [one(d.upper.top, "UP置顶")] : []),
  ];
  const list = [...top, ...(d?.replies || []).filter(Boolean).map((r) => one(r))];
  return {
    // count 是根评论数，acount 含楼中楼；"看完评论区"看的是根评论，所以 total 用 count。
    total: Number(d?.page?.count ?? 0),
    acount: Number(d?.page?.acount ?? 0),
    sort: sort === "time" ? "time" : "hot",
    page: pn,
    list,
  };
}

/** 评论优先级：置顶 → UP 自己发的 → 点赞高的。同档点赞降序，稳定不乱序。 */
export function rankComments(list) {
  const tier = (c) => (c?.tag ? 0 : c?.isUp ? 1 : 2);
  return (Array.isArray(list) ? list : []).map((c, i) => ({ c, i }))
    .sort((a, b) => tier(a.c) - tier(b.c)
      || (Number(b.c?.like) || 0) - (Number(a.c?.like) || 0)
      || a.i - b.i)
    .map((x) => x.c);
}

/**
 * 翻页抓评论，按"置顶 → UP 发言 → 点赞"排序后返回。
 *
 * - `mode="hot"` 只翻热度（2），`"time"` 只翻时间（0），`"all"` 先热度，不够再用时间补齐；
 *   实测热度排序能翻到很深（37 页 / 740 条），时间序作为覆盖面兜底，防止热度分页漏掉冷门楼。
 * - `want=Infinity` 表示"尽量看完"；`maxPages` 是请求数硬预算（默认 80 页 = 1600 条），
 *   到了就停，并让调用方知道没到底——绝不把"预算用完"说成"评论区只有这些"。
 * - `fetchPage` 由调用方注入，单测里换成假分页即可。
 */
export async function collectComments(fetchPage, {
  want = 20, ps = 20, maxChars = 200, upMid = null, mode = "all", maxPages = 80, log = () => {},
} = {}) {
  const limit = want === Infinity ? Infinity : Math.max(1, Math.floor(Number(want) || 0));
  const passes = mode === "time" ? ["time"] : mode === "hot" ? ["hot"] : ["hot", "time"];
  const seen = new Map();
  let total = 0, acount = 0, pages = 0, stopped = "exhausted";
  for (const [passIndex, sort] of passes.entries()) {
    const last = passIndex === passes.length - 1;
    let dupPages = 0, passStatus = "exhausted";
    for (let pn = 1; ; pn++) {
      if (seen.size >= limit) { passStatus = "want"; break; }
      if (pages >= maxPages) { passStatus = "max_pages"; break; }
      const page = await fetchPage({ ps, pn, sort, maxChars, upMid });
      pages++;
      if (page?.total) total = page.total;
      if (page?.acount) acount = page.acount;
      const list = Array.isArray(page?.list) ? page.list : [];
      if (!list.length) { passStatus = "exhausted"; break; }
      let fresh = 0;
      for (const c of list) {
        const id = String(c?.rpid ?? "");
        if (!id || seen.has(id)) continue;
        seen.set(id, c); fresh++;
      }
      // 热度翻页偶尔原地打转：连续两页全重复才算到底；时间序在开头本来就和热度序重复，放宽到三页。
      const dupLimit = sort === "hot" ? 2 : 3;
      dupPages = fresh ? 0 : dupPages + 1;
      if (pages % 10 === 0) log(`评论翻页 ${pages} 页，已收 ${seen.size} 条`);
      if (dupPages >= dupLimit) { passStatus = "exhausted"; break; }
      if (list.length < ps) { passStatus = "exhausted"; break; }
    }
    stopped = passStatus;
    if (passStatus !== "exhausted" || last) break;
    // 热度翻到底且接口报的总数已经收齐：不再拿时间序白跑一遍。
    if (total && seen.size >= total) break;
    // 否则换时间序补齐（热度分页漏楼时，时间序能补上冷门楼）。
    log(`评论按${sort === "hot" ? "热度" : "时间"}序翻到底（${seen.size}/${total || "?"} 条），换序补齐`);
  }
  // 先排序再截断：要 30 条就给"最该看的 30 条"，而不是"前 40 条再砍"。
  const list = rankComments([...seen.values()]).slice(0, limit);
  return { list, total, acount, pages, mode, stopped,
    exhausted: stopped === "exhausted", truncated: stopped === "max_pages" };
}

/** 楼中楼单页。 */
export async function getReplies(api, aid, root, { ps = 20, pn = 1, maxChars = 200, upMid = null } = {}) {
  const d = await api.request(API.replyReply, { type: 1, oid: aid, root, ps, pn });
  const up = upMid == null || upMid === "" ? null : String(upMid);
  const list = (d?.replies || []).filter(Boolean).map((r) => ({
    rpid: String(r.rpid ?? ""),
    root: String(root),
    name: r.member?.uname ?? "匿名",
    mid: String(r.member?.mid ?? ""),
    isUp: up != null && String(r.member?.mid ?? "") === up,
    like: Number(r.like ?? 0),
    time: commentTime(r.ctime),
    text: String(r.content?.message ?? "").replace(/\s+/g, " ").trim().slice(0, maxChars),
  }));
  return { root: String(root), total: Number(d?.page?.count ?? list.length), list };
}

/** 把一条根评论的楼中楼翻到底（受 maxPages 限制），UP 的发言优先排在前面。 */
export async function collectReplies(fetchReplies, root, { maxPages = 3, ps = 20, maxChars = 200, upMid = null } = {}) {
  const seen = new Map();
  let total = 0;
  for (let pn = 1; pn <= maxPages; pn++) {
    const page = await fetchReplies({ root, ps, pn, maxChars, upMid });
    total = page?.total || total;
    const list = page?.list || [];
    if (!list.length) break;
    for (const c of list) if (!seen.has(c.rpid)) seen.set(c.rpid, c);
    if (list.length < ps) break;
  }
  return { root: String(root), total, list: rankComments([...seen.values()]) };
}

/**
 * 取播放直链。qn 16=360p / 32=480p / 64=720p / 80=1080p。
 * fnval=16 要 DASH。
 */
export async function getPlayurl(api, bvid, cid, { qn = 16 } = {}) {
  const d = await api.request(API.playurl, {
    bvid,
    cid,
    qn,
    fnval: 16,
    fnver: 0,
    fourk: 0,
  });
  const dash = d?.dash;
  if (!dash) {
    const durl = d?.durl?.[0];
    return durl ? { kind: "durl", url: durl.url, length: durl.length } : null;
  }
  const videos = (dash.video || []).map((v) => ({
    id: v.id,
    url: v.baseUrl || v.base_url,
    bandwidth: v.bandwidth,
    codecs: v.codecs,
    width: v.width,
    height: v.height,
  }));
  const audios = (dash.audio || []).map((a) => ({
    id: a.id,
    url: a.baseUrl || a.base_url,
    bandwidth: a.bandwidth,
    codecs: a.codecs,
  }));
  return {
    kind: "dash",
    video: [...videos].sort((a, b) => a.bandwidth - b.bandwidth),
    audio: [...audios].sort((a, b) => a.bandwidth - b.bandwidth),
  };
}

/** 下载任意 B 站直链（带 Referer；支持 Range 断点续传）。 */
export async function downloadStream(url, file, { onProgress, referer = REFERER } = {}) {
  await mkdir(dirname(file), { recursive: true });

  let start = 0;
  try {
    const s = await stat(file);
    start = s.size;
  } catch { /* 新文件 */ }

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Referer: referer,
  };
  if (start > 0) headers.Range = `bytes=${start}-`;

  let res = await fetch(url, { headers });
  // 416 = 已有文件已经完整（或远端大小变了）。删掉重下一次，别把复跑卡死。
  if (res.status === 416 && start > 0) {
    await res.body?.cancel();
    start = 0;
    delete headers.Range;
    res = await fetch(url, { headers });
  }
  // 服务器忽略 Range 直接回 200：整个文件从头来，否则 append 会把内容写两遍
  if (start > 0 && res.status === 200) {
    start = 0;
  }
  if (!res.ok && res.status !== 206) throw new Error(`下载失败 HTTP ${res.status}`);
  if (!res.body) throw new Error("下载失败：空响应");
  if (res.status === 206) {
    const range = res.headers.get("content-range")?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/);
    if (!range || Number(range[1]) !== start || Number(range[2]) < start) {
      await res.body.cancel();
      throw new Error("下载失败：Content-Range 与本地断点不一致");
    }
  }

  const total = Number(res.headers.get("content-length") || 0) + start;
  let seen = start;
  const sink = createWriteStream(file, { flags: start > 0 ? "a" : "w" });
  const body = Readable.fromWeb(res.body);
  body.on("data", (c) => {
    seen += c.length;
    onProgress?.({ seen, total });
  });
  await pipeline(body, sink);
  return { file, bytes: seen };
}

export function fmtBytes(n) {
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

export function fmtClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/** 下载进度条（10% 一档，避免刷屏）。 */
export function progressBar(label) {
  let lastPct = -1;
  const t0 = Date.now();
  return ({ seen, total }) => {
    const pct = total ? Math.floor((seen / total) * 100) : 0;
    if (pct !== lastPct && pct % 10 === 0) {
      lastPct = pct;
      const sp = seen / ((Date.now() - t0) / 1000 || 1);
      process.stdout.write(
        `\r  ${label}  ${String(pct).padStart(3)}%  ${fmtBytes(seen)}${total ? "/" + fmtBytes(total) : ""}  ${fmtBytes(sp)}/s   `
      );
    }
  };
}

/** 确保本地有视频文件（默认 360p），返回路径与播放信息。 */
export async function ensureVideoFile(api, bvid, cid, { qn = 16 } = {}) {
  const dir = join(CACHE, bvid);
  const file = join(dir, `video_${qn}.mp4`);
  const play = await getPlayurl(api, bvid, cid, { qn });
  if (!play) throw new Error("拿不到播放直链（可能需要登录/大会员）");
  if (play.kind === "durl") {
    await downloadStream(play.url, file, { onProgress: progressBar(`${bvid} 视频`) });
    return { file, play };
  }
  const stream = play.video[0];
  await downloadStream(stream.url, file, {
    onProgress: progressBar(`${bvid} 视频 ${stream.width}x${stream.height}`),
  });
  return { file, play, stream };
}

/** 确保本地有独立音轨（DASH 才有）。 */
export async function ensureAudioFile(api, bvid, cid, { onProgress = progressBar(`${bvid} 音频`) } = {}) {
  const dir = join(CACHE, bvid);
  const file = join(dir, "audio.m4a");
  const play = await getPlayurl(api, bvid, cid, { qn: 16 });
  if (!play) throw new Error("拿不到播放直链");
  if (play.kind === "durl") throw new Error("老格式视频没有独立音轨，改用视频抽音频");
  const a = play.audio[0];
  await downloadStream(a.url, file, { onProgress });
  return { file, play };
}
