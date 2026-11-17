import { join } from "node:path";
import { CACHE } from "./paths.mjs";
import { readJson } from "./fsx.mjs";
import { materialStore, digest } from "./material-cache.mjs";
import { getView, getPages, firstPartView, getPlayer, fetchSubtitle, getDanmakuPeaks, getComments, getReplies,
  collectComments, collectReplies } from "./media.mjs";

/** 评论区：每页 20 条（接口上限），默认最多翻 80 页 = 1600 条。 */
export const COMMENT_PS = 20;
export const COMMENT_MAX_PAGES = 80;
export const COMMENT_TTL_MS = 900_000;

export async function openMaterials(api, bvid, { cacheRoot = CACHE, refresh = false, offline = false, services = {} } = {}) {
  const io = { getView, getPages, getPlayer, fetchSubtitle, getDanmakuPeaks, getComments, getReplies, ...services };
  const dir = join(cacheRoot, bvid);
  const store = materialStore(dir, { scope: String(api?.cookies?.DedeUserID || "anonymous"), refresh, offline });
  let view, pages;
  try {
    const raw = await store.get("view2", { bvid }, () => io.getView(api, bvid), { ttl: 6 * 3600_000 });
    if (!raw) throw new Error(`拿不到视频信息：${bvid}`);
    pages = await store.get("pages", { bvid }, () => io.getPages(api, bvid), { ttl: 6 * 3600_000 });
    view = firstPartView(raw, pages);
  } catch (err) {
    if (!offline) throw err;
    const packet = await readJson(join(dir, "packet.json"), null);
    if (packet?.bvid !== bvid || !packet.view?.cid || !(packet.view.duration > 0)) throw err;
    view = { ...packet.view, multiPart: packet.multiPart || packet.view.multiPart, pageCount: packet.pageCount || 1 };
    pages = [{ cid: view.cid, duration: view.duration, page: 1, part: view.part }];
  }
  const identity = { bvid, cid: view.cid, duration: view.duration };
  const upMid = view.owner?.mid ?? null;
  // 单页抓取入口：默认走 media.getComments，services 可替换（单测用假分页）。
  const fetchPage = (opts) => io.getComments(api, view.aid, { upMid, ...opts });
  const fetchReplies = (opts) => io.getReplies(api, view.aid, opts.root, { upMid, ...opts });
  return { dir, view, pages, cid: view.cid, identity, store,
    player: (fresh = false) => store.get("player", identity, async () => {
      const p = await io.getPlayer(api, bvid, view.cid);
      return { subtitles: p.subtitles || [], acceptQuality: p.acceptQuality || [], source: p.source || "unknown" };
    }, { fresh, ttl: 300_000 }),
    subtitle: (candidate, fresh = false) => store.get(`subtitle-${digest(candidate.lan || "unknown").slice(0, 10)}`,
      { ...identity, lan: candidate.lan, url: digest(candidate.url) }, () => io.fetchSubtitle(api, candidate.url), { fresh, ttl: 300_000 }),
    danmaku: () => store.get("danmaku", identity, () => io.getDanmakuPeaks(api, view.cid), { ttl: 900_000 }),
    // 正文比峰值大得多，单独一条缓存；失败/解析异常仍由调用方显式处理，不能当零弹幕。
    danmakuText: (fresh = false) => store.get("danmaku-text", identity,
      () => io.getDanmakuPeaks(api, view.cid, { bucketSec: 30, withText: true, duration: view.duration }),
      { fresh, ttl: 6 * 3600_000 }),
    // 评论区：want=Infinity 表示"尽量看完"，mode=hot|time|all，maxPages 是请求数预算。
    // 缓存按"覆盖量"复用：已经收够（或已翻到底）就直接用，否则强制重取，绝不把浅抓的 20 条当成 200 条。
    comments: (want = 5, { mode = "all", maxPages = COMMENT_MAX_PAGES, maxChars = 400, log } = {}) => {
      const requested = want === Infinity ? Infinity : Math.max(1, Math.floor(Number(want) || 0));
      const key = { bvid, aid: view.aid, ps: COMMENT_PS, mode };
      return (async () => {
        const cached = await store.peekFresh("comments3", key, COMMENT_TTL_MS);
        const have = cached?.value?.list?.length || 0;
        // 已经翻到底的旧结果能顶替任何更大的 want：评论区就这么大，再取也一样。
        const enough = cached && (cached.value.exhausted === true || have >= requested);
        if (enough) return cached.value;
        return store.get("comments3", key, async () => {
          const collect = io.collectComments || ((opts) => collectComments(fetchPage, opts));
          const value = await collect({ want: requested, ps: COMMENT_PS, maxChars, upMid, mode, maxPages, log });
          return { ...value, want: requested === Infinity ? "all" : requested,
            fetchedAt: new Date().toISOString() };
        }, { ttl: COMMENT_TTL_MS, fresh: !!cached });
      })();
    },
    // 楼中楼：显式要才翻，默认只带每条根评论内联的 3 条预览。
    replies: (root, { maxPages = 3, maxChars = 400 } = {}) =>
      store.get(`replies-${digest(String(root)).slice(0, 10)}`, { bvid, aid: view.aid, root },
        () => (io.collectReplies || ((opts) => collectReplies(fetchReplies, opts.root, opts)))({ root, maxPages, maxChars, upMid }),
        { ttl: COMMENT_TTL_MS }),
    peekDanmaku: () => store.peek("danmaku", identity),
    peekDanmakuText: () => store.peek("danmaku-text", identity),
    // 三种翻页口径各自一份缓存，任一命中都能用来报"保留已有材料"。
    peekComments: async () => {
      for (const mode of ["all", "hot", "time"]) {
        const hit = await store.peek("comments3", { bvid, aid: view.aid, ps: COMMENT_PS, mode });
        if (hit) return hit;
      }
      return null;
    },
  };
}
