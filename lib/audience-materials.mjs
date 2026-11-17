import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { writeTextAtomic } from "./fsx.mjs";
import { fmtClock } from "./media.mjs";
import { stopOnAccountError } from "./subtitle-quality.mjs";

const known = (info) => ["available", "empty"].includes(info?.status);
const status = (total) => total > 0 ? "available" : "empty";
const validTotal = (n) => Number.isInteger(n) && n >= 0;
const cacheTime = (at) => Number.isFinite(at) && Math.abs(at) <= 8.64e15 ? new Date(at).toISOString() : null;
const validPeaks = (peaks, duration) => Array.isArray(peaks) && peaks.every((p) =>
  Number.isFinite(p?.sec) && p.sec >= 0 && p.sec <= duration + 1 && Number.isInteger(p.n) && p.n > 0);
const topPeaks = (peaks) => peaks.slice().sort((a, b) => b.n - a.n).slice(0, 12).sort((a, b) => a.sec - b.sec);
const commentsList = (list, limit = Infinity) => {
  if (!Array.isArray(list)) throw new Error("评论响应缺少列表");
  const seen = new Set();
  return list.filter((c) => c && c.rpid != null && typeof c.text === "string" &&
    !seen.has(String(c.rpid)) && seen.add(String(c.rpid))).slice(0, limit);
};

/** Retain audience signals without treating skipped/failed acquisition as an empty response. */
export async function collectAudience(context, oldPacket,
  { danmaku, comments, commentsMode = "all", commentMaxPages, log, warnings }) {
  const { dir, identity } = context;
  const matches = oldPacket?.bvid === identity.bvid && String(oldPacket.view?.cid) === String(identity.cid)
    && Math.abs(oldPacket.view?.duration - identity.duration) <= 1;
  const old = matches ? oldPacket.materials || {} : {};
  let d = null, c = null;
  if (validTotal(old.danmakuTotal) && (old.danmakuTotal > 0 || known(old.danmakuInfo)) && validPeaks(oldPacket?.peaks, identity.duration))
    d = { total: old.danmakuTotal, peaks: oldPacket.peaks, fetchedAt: old.danmakuInfo?.fetchedAt || null, origin: "previous_packet" };
  if (Array.isArray(old.comments) && (old.comments.length || known(old.commentsInfo)))
    c = { list: commentsList(old.comments), fetchedAt: old.commentsInfo?.fetchedAt || null, origin: "previous_packet" };

  const cachedD = await context.peekDanmaku(), cachedC = await context.peekComments();
  if (cachedD && validTotal(cachedD.value?.total) && validPeaks(cachedD.value?.peaks, identity.duration))
    d = { ...cachedD.value, fetchedAt: cacheTime(cachedD.at), origin: "cache" };
  if (cachedC && Array.isArray(cachedC.value?.list))
    c = { list: commentsList(cachedC.value.list), fetchedAt: cacheTime(cachedC.at), origin: "cache" };

  // Earlier prepare versions erased packet fields but left this identified file intact.
  const danmakuPath = join(dir, "danmaku_peaks.txt");
  if (!d && matches) {
    const text = await readFile(danmakuPath, "utf8").catch(() => "");
    const total = text.match(/共\s*(\d+)\s*条/);
    const peaks = [...text.matchAll(/^(\d+(?::\d{2}){1,2})\t(\d+)\s*$/gm)].map((m) =>
      ({ sec: m[1].split(":").reduce((n, v) => n * 60 + Number(v), 0), n: Number(m[2]) }));
    if (text.split(/\r?\n/)[0]?.trim() === `BV: ${identity.bvid}` && total &&
      validTotal(Number(total[1])) && validPeaks(peaks, identity.duration) && (Number(total[1]) === 0 || peaks.length))
      d = { total: Number(total[1]), peaks, fetchedAt: null, origin: "legacy_file" };
  }

  let dError = null, cError = null, dRetained = !!d, cRetained = !!c;
  if (danmaku) {
    try {
      const value = await context.danmaku();
      if (!validTotal(value?.total) || !validPeaks(value.peaks, identity.duration)) throw new Error("弹幕响应格式无效");
      const snapshot = await context.peekDanmaku();
      d = { ...value, fetchedAt: snapshot ? cacheTime(snapshot.at) : null, origin: "material_store" };
      dRetained = false;
    } catch (err) { stopOnAccountError(err); dError = err.message; warnings.push(`弹幕未取得：${err.message}${d ? "；保留已有材料" : ""}`); }
  }
  if (comments) {
    try {
      const value = await context.comments(comments, { mode: commentsMode, maxPages: commentMaxPages, log });
      const list = commentsList(value?.list, comments);
      // fetchedAt 由抓取时刻给出，缓存复用时不会被"写入缓存的时间"顶替。
      c = { list, fetchedAt: value?.fetchedAt || null, origin: "material_store",
        available: Number.isInteger(value?.total) ? value.total : null,
        acount: Number.isInteger(value?.acount) ? value.acount : null,
        collected: Array.isArray(value?.list) ? value.list.length : null,
        pages: Number.isInteger(value?.pages) ? value.pages : null,
        mode: value?.mode || commentsMode, exhausted: value ? Boolean(value.exhausted) : null };
      cRetained = false;
      // "没翻到底"必须说清楚，不能让人以为评论区只有这几条。接口的 count 含楼中楼，只信采集器自己的预算信号。
      if (comments === Infinity && value?.truncated)
        warnings.push(`评论区未翻到底：已取 ${list.length} 条就撞上 --max-comment-pages 预算（默认 80 页，可调大）`);
    } catch (err) { stopOnAccountError(err); cError = err.message; warnings.push(`评论未取得：${err.message}${c ? "；保留已有材料" : ""}`); }
  }
  const peaks = d ? topPeaks(d.peaks) : [];
  if (d) await writeTextAtomic(danmakuPath, `BV: ${identity.bvid}\n共 ${d.total} 条\n` + peaks.map((p) => `${fmtClock(p.sec)}\t${p.n}`).join("\n") + "\n");
  const info = (value, requested, retained, error, total, extra = {}) => ({ status: value ? status(total) : error ? "unavailable" : "not_requested",
    requested, retained, origin: value?.origin || null, fetchedAt: value?.fetchedAt || null, error, ...extra });
  return { peaks, materials: { danmaku: d ? danmakuPath : null, danmakuTotal: d?.total ?? null,
    danmakuInfo: info(d, danmaku, dRetained, dError, d?.total), comments: c?.list || [],
    commentsAvailable: c?.available ?? null, commentsCollected: c?.collected ?? null,
    commentsInfo: info(c, comments > 0, cRetained, cError, c?.list.length,
      { mode: c?.mode ?? null, pages: c?.pages ?? null, exhausted: c?.exhausted ?? null,
        acount: c?.acount ?? null, collected: c?.collected ?? null,
        upCount: (c?.list || []).filter((x) => x.isUp).length }),
    commentsSource: "community_unverified" } };
}

export function audienceDescription(packet, kind) {
  const m = packet.materials || {}, info = m[`${kind}Info`];
  const total = kind === "danmaku" ? m.danmakuTotal : m.comments?.length;
  const available = known(info) || !info && total > 0;
  if (available) {
    if (kind === "comments") {
      // 评论区最怕"看起来取了其实只取了一页"：条数、排序口径、是否翻到底都要报出来。
      // 接口的 count 往往把楼中楼一起算进来（实测 493 条根评论报成 972），所以只作参考。
      const mode = info?.mode === "time" ? "时间序" : info?.mode === "hot" ? "热度序" : "置顶→UP→点赞序";
      const up = info?.upCount ?? (m.comments || []).filter((c) => c.isUp).length;
      const cover = info?.exhausted === true ? "已翻到底" : info?.exhausted === false ? "未翻到底" : "覆盖未知";
      const stats = [mode, `UP ${up} 条`, cover,
        info?.pages ? `${info.pages} 页` : null,
        Number.isInteger(m.commentsCollected) && m.commentsCollected > total ? `缓存里已取 ${m.commentsCollected} 条` : null,
        m.commentsAvailable ? `接口计 ${m.commentsAvailable} 条含楼中楼` : null,
      ].filter(Boolean).join("，");
      return `${info?.retained ? "保留已有材料（未重新获取）" : "已获取"}，${total} 条（${stats}）`
        + `${info?.fetchedAt ? `；材料时间 ${info.fetchedAt}` : "；获取时间未知"}${info?.error ? "；本次获取失败" : ""}`;
    }
    const counts = `${total} 条，${packet.peaks?.length || 0} 个峰值点`;
    return `${info?.retained ? "保留已有材料（未重新获取）" : "已获取"}，${counts}${info?.fetchedAt ? `；材料时间 ${info.fetchedAt}` : "；获取时间未知"}${info?.error ? "；本次获取失败" : ""}`;
  }
  if (info?.status === "not_requested") return "本次未请求，不能据此判断视频是否有此材料";
  if (info?.status === "unavailable") return "获取失败，无可用材料，不能据此判断视频是否有此材料";
  return "旧包未记录获取状态，请重新 prepare 核对";
}
