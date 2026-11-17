import { FILES } from "./paths.mjs";
import { cookieHeader } from "./cookies.mjs";
import { readJson, writeJsonAtomic, sleep } from "./fsx.mjs";
import { beforeRequest, trip, clearStrikes } from "./traffic.mjs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export const API = {
  nav: "https://api.bilibili.com/x/web-interface/nav",
  spi: "https://api.bilibili.com/x/frontend/finger/spi",
  folders: "https://api.bilibili.com/x/v3/fav/folder/created/list-all",
  folderList: "https://api.bilibili.com/x/v3/fav/folder/created/list",
  favList: "https://api.bilibili.com/x/v3/fav/resource/list",
  favIds: "https://api.bilibili.com/x/v3/fav/resource/ids",
  view: "https://api.bilibili.com/x/web-interface/view",
  // 本机实测 /view 会被 412，/view/detail 正常
  viewDetail: "https://api.bilibili.com/x/web-interface/view/detail",
  pagelist: "https://api.bilibili.com/x/player/pagelist",
  playerV2: "https://api.bilibili.com/x/player/v2",
  playerWbiV2: "https://api.bilibili.com/x/player/wbi/v2",
  danmaku: "https://api.bilibili.com/x/v1/dm/list.so",
  reply: "https://api.bilibili.com/x/v2/reply",
  replyReply: "https://api.bilibili.com/x/v2/reply/reply",
  playurl: "https://api.bilibili.com/x/player/playurl",
};

export class BiliError extends Error {
  constructor(message, { code, status, body } = {}) {
    super(message);
    this.name = "BiliError";
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

export class RiskControlError extends BiliError {
  constructor(message, meta) {
    super(message, meta);
    this.name = "RiskControlError";
  }
}

export class NotLoggedInError extends BiliError {
  constructor(message, meta) {
    super(message, meta);
    this.name = "NotLoggedInError";
  }
}

const RISK_CODES = new Set([-412, -352, -799, -509]);

export class BiliApi {
  /**
   * @param {object} opts
   * @param {Record<string,string>|null} opts.cookies
   * @param {number} [opts.minDelay] 毫秒
   * @param {number} [opts.maxDelay] 毫秒
   * @param {number} [opts.retries]
   * @param {(msg:string)=>void} [opts.log]
   */
  constructor({ cookies = null, minDelay = 1000, maxDelay = 1800, retries = 3, log = () => {} } = {}) {
    this.cookies = { ...(cookies || {}) };
    this.minDelay = minDelay;
    this.maxDelay = maxDelay;
    this.retries = retries;
    this.log = log;
    this.calls = 0;
    this._buvid = null;
  }

  async init() {
    await this.ensureBuvid();
    return this;
  }

  /** 没有 buvid3 就去拿一对，缓存一天。风控主要看这个。 */
  async ensureBuvid() {
    if (this.cookies.buvid3 && this.cookies.buvid4) return;
    const cached = await readJson(FILES.buvid, null);
    const fresh = cached && Date.now() - (cached.at || 0) < 24 * 3600 * 1000;
    let b3 = fresh ? cached.b_3 : null;
    let b4 = fresh ? cached.b_4 : null;
    if (!b3 || !b4) {
      const data = await this.request(API.spi, {}, { retry: false, noThrottle: true, bare: true });
      b3 = data?.b_3;
      b4 = data?.b_4;
      if (b3) await writeJsonAtomic(FILES.buvid, { b_3: b3, b_4: b4, at: Date.now() });
    }
    if (b3) this.cookies.buvid3 = b3;
    if (b4) this.cookies.buvid4 = b4;
  }

  #headers({ bare = false } = {}) {
    const cookie = cookieHeader(this.cookies);
    const h = {
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9",
      Referer: "https://www.bilibili.com/",
      Origin: "https://www.bilibili.com",
    };
    if (!bare) {
      Object.assign(h, {
        "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site",
      });
    }
    if (cookie) h.Cookie = cookie;
    return h;
  }

  async #throttle() {
    const ms = this.minDelay + Math.random() * (this.maxDelay - this.minDelay);
    await sleep(ms);
  }

  /**
   * 请求一个 B 站 API，返回 data 字段。
   * 412 / HTML 响应 / 风控码 → 指数退避重试；-101 → 抛 NotLoggedInError。
   */
  async request(url, params = {}, { retry = true, noThrottle = false, bare = false, rawQuery } = {}) {
    const qs = rawQuery ?? new URLSearchParams(
      Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => [k, String(v)])
    ).toString();
    const full = qs ? `${url}?${qs}` : url;
    const attempts = retry ? this.retries + 1 : 1;
    let lastErr;

    for (let i = 0; i < attempts; i++) {
      await beforeRequest({ skipDelay: noThrottle });
      this.calls++;
      let res;
      try {
        res = await fetch(full, { headers: this.#headers({ bare }), redirect: "follow" });
      } catch (err) {
        lastErr = new BiliError(`网络错误：${err.message}`, {});
        if (i < attempts - 1) { await sleep(2000 * (i + 1)); continue; }
        throw lastErr;
      }

      const text = await res.text();
      const looksHtml = text.trimStart().startsWith("<");

      if (res.status === 412 || looksHtml) {
        // 412 是 IP 级限流，重试没有意义；直接熔断，免得把账号往枪口上顶。
        const minutes = await trip(`HTTP ${res.status}`);
        throw new RiskControlError(
          `被风控（HTTP ${res.status}${looksHtml ? "，返回 HTML" : ""}）：${url.split("?")[0]}；已暂停 ${minutes} 分钟`,
          { status: res.status, code: -412, body: text.slice(0, 200) }
        );
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new BiliError(`响应不是 JSON：${text.slice(0, 120)}`, { status: res.status });
      }

      if (json.code === 0) {
        await clearStrikes().catch(() => {});
        return json.data;
      }
      if (json.code === -101) {
        throw new NotLoggedInError("未登录或 Cookie 已失效（code -101）", { code: -101, status: res.status });
      }
      if (RISK_CODES.has(json.code)) {
        const minutes = await trip(`code ${json.code}`);
        throw new RiskControlError(
          `风控码 ${json.code}：${json.message}；已暂停 ${minutes} 分钟`,
          { code: json.code, status: res.status }
        );
      }
      throw new BiliError(`接口返回 code=${json.code}：${json.message || ""}`, {
        code: json.code,
        status: res.status,
      });
    }
    throw lastErr;
  }

  async nav() {
    return this.request(API.nav, {}, { noThrottle: true });
  }

  /** 当前登录账号；未登录返回 null。 */
  async whoami() {
    try {
      const d = await this.nav();
      if (!d || !d.isLogin) return null;
      return { mid: d.mid, uname: d.uname, vip: d.vipStatus === 1, level: d.level_info?.current_level };
    } catch (err) {
      if (err instanceof NotLoggedInError) return null;
      throw err;
    }
  }

  /** 我创建的全部收藏夹（含默认收藏夹）。 */
  async myFolders(mid) {
    const d = await this.request(API.folders, { up_mid: mid, web_location: "333.1387" });
    const list = d?.list || [];
    return list.map((f) => ({
      id: f.id,
      fid: f.fid,
      title: f.title,
      count: f.media_count,
      attr: f.attr,
      isDefault: f.title === "默认收藏夹",
    }));
  }

  /** 收藏夹一页（20 条）。 */
  async favPage(mediaId, pn = 1, ps = 20) {
    const d = await this.request(API.favList, {
      media_id: mediaId,
      pn,
      ps,
      keyword: "",
      order: "mtime",
      type: 0,
      tid: 0,
      platform: "web",
    });
    return {
      info: d?.info || null,
      medias: (d?.medias || []).filter(Boolean),
      hasMore: Boolean(d?.has_more),
    };
  }

  /** 收藏夹全量，边翻页边回调；shouldStop 可用于增量提前收手。 */
  async favAll(mediaId, { onPage, shouldStop, maxPages = 500, ps = 20 } = {}) {
    const out = [];
    let pn = 1;
    let info = null;
    while (pn <= maxPages) {
      const page = await this.favPage(mediaId, pn, ps);
      if (!info && page.info) info = page.info;
      if (page.medias.length === 0) break;
      out.push(...page.medias);
      onPage?.({ page, pn, total: out.length });
      if (shouldStop?.(page, pn)) break;
      if (!page.hasMore) break;
      pn++;
      if (pn > maxPages) throw new Error(`收藏夹超过 ${maxPages} 页上限，未将部分结果当成完整列表保存`);
    }
    return { info, medias: out };
  }
}

/** 把 API 的 media 对象压成我们自己的形状。 */
export function normalizeMedia(m, folder) {
  const title = (m.title || "").trim();
  const bvid = m.bvid || m.bv_id || null;
  // B 站把已下架的视频也留在收藏夹里，标题变成「已失效视频」
  const dead = !bvid || /已失效/.test(title);
  return {
    bvid,
    aid: m.id ?? null,
    title,
    intro: (m.intro || "").trim(),
    cover: m.cover || "",
    duration: m.duration ?? null,
    pubtime: m.pubtime ?? null,
    favTime: m.fav_time ?? null,
    up: m.upper?.name ?? "",
    upMid: m.upper?.mid ?? null,
    type: m.type ?? null,
    invalid: dead || undefined,
    folderId: folder.id,
    folderTitle: folder.title,
    link: bvid ? `https://www.bilibili.com/video/${bvid}` : "",
  };
}
