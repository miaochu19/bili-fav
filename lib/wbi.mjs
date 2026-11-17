// WBI 签名。B 站 2023 年之后部分接口（含 /x/player/wbi/v2）要求 w_rid + wts 签名，
// 不签名也能拿到 subtitle_url，但那个 URL **缺 auth_key**，CDN 会返回 403 或**别人的字幕**。
// 算法来自 bilibili-API-collect 的公开说明；MIXIN 表是固定常量。
import crypto from "node:crypto";

const MIXIN = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19,
  29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

const KEY_TTL_MS = 10 * 60 * 1000;
let keyCache = { at: 0, raw: null };

function keyOf(url) {
  const s = String(url || "");
  const tail = s.slice(s.lastIndexOf("/") + 1);
  return tail.slice(0, Math.max(0, tail.lastIndexOf(".")));
}

/** 取 wbi_img 的两个 key，拼成 64 字符原始串；10 分钟缓存（B 站会轮换）。 */
async function wbiRaw(api) {
  if (keyCache.raw && Date.now() - keyCache.at < KEY_TTL_MS) return keyCache.raw;
  const nav = await api.request("https://api.bilibili.com/x/web-interface/nav", {}, { noThrottle: true });
  const raw = keyOf(nav?.wbi_img?.img_url) + keyOf(nav?.wbi_img?.sub_url);
  if (raw.length !== 64) throw new Error("WBI key 缺失：nav 没返回 wbi_img（可能未登录或接口变更）");
  keyCache = { at: Date.now(), raw };
  return raw;
}

function mixinKey(raw) {
  return MIXIN.map((i) => raw[i]).join("").slice(0, 32);
}

const clean = (v) => String(v).replace(/[!'()*]/g, "");

/**
 * 返回可直接拼到 URL 后的查询串（含 wts 与 w_rid）。
 * 用法：`${API.playerWbiV2}?${await signedQuery(api, { bvid, cid })}`
 */
export async function signedQuery(api, params = {}, { now = Date.now() } = {}) {
  const raw = await wbiRaw(api);
  const key = mixinKey(raw);
  const wts = Math.floor(now / 1000);
  const values = { ...params, wts };
  const query = Object.keys(values)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(clean(values[k]))}`)
    .join("&");
  const rid = crypto.createHash("md5").update(query + key).digest("hex");
  return `${query}&w_rid=${rid}`;
}

/** 清掉 key 缓存（测试或换号后用）。 */
export function resetWbiKeys() {
  keyCache = { at: 0, raw: null };
}
