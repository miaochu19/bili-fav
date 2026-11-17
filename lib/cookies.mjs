import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { FILES } from "./paths.mjs";
import { readJson, writeJsonAtomic } from "./fsx.mjs";

const KEYS = ["SESSDATA", "bili_jct", "DedeUserID", "buvid3", "buvid4"];

/** "a=1; b=2" / "a=1&b=2" / 多行 → 对象（键名做大小写归一）。 */
export function parseCookieString(str) {
  const out = {};
  const known = new Set(KEYS.map((k) => k.toLowerCase()));
  for (const part of String(str).split(/[;\r\n&]+/)) {
    const m = part.match(/^\s*([^=]+?)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1];
    if (!known.has(key.toLowerCase())) continue;
    out[KEYS.find((k) => k.toLowerCase() === key.toLowerCase())] = m[2];
  }
  return out;
}

/** Netscape cookies.txt → 对象（只挑我们认识的键）。 */
export function parseNetscapeCookies(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 7) continue;
    const name = parts[5];
    const value = parts[6];
    const hit = KEYS.find((k) => k.toLowerCase() === name.toLowerCase());
    if (hit) out[hit] = value;
  }
  return out;
}

export function hasLogin(cookies) {
  return Boolean(cookies && cookies.SESSDATA && cookies.SESSDATA.length > 10);
}

export function cookieHeader(cookies) {
  if (!cookies) return "";
  return Object.entries(cookies)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

export function redact(cookies) {
  if (!cookies) return "(none)";
  const out = {};
  for (const k of KEYS) {
    if (cookies[k]) out[k] = `${String(cookies[k]).slice(0, 4)}…(${String(cookies[k]).length})`;
  }
  return out;
}

/**
 * 加载顺序：显式 --cred 路径 → 环境变量 → data/cookies.json → 匿名。
 * 支持 JSON 与 Netscape cookies.txt 两种文件格式。
 */
export async function loadCookies({ credPath, env = process.env } = {}) {
  let cookies = null;
  let source = "anonymous";

  if (credPath) {
    cookies = await readCookieFile(credPath);
    source = credPath;
  } else if (env.BILI_SESSDATA) {
    cookies = {
      SESSDATA: env.BILI_SESSDATA,
      bili_jct: env.BILI_JCT,
      DedeUserID: env.BILI_USERID,
      buvid3: env.BILI_BUVID3,
      buvid4: env.BILI_BUVID4,
    };
    source = "env";
  } else {
    // 优先读 surfcore 扫码登录写的那份（DSH_HOME/surfcore/bili/credentials.json），
    // 这样"设置页扫一次码"就能同时喂饱桥接和本 CLI，不必再手动粘贴。
    const shared = await readSharedCredentials(env);
    if (shared) {
      cookies = shared;
      source = "surfcore credentials.json";
    } else {
      cookies = await readCookieFile(FILES.cookies, { silent: true });
      if (cookies) source = "data/cookies.json";
    }
  }

  if (cookies) {
    for (const k of Object.keys(cookies)) {
      if (cookies[k] === undefined || cookies[k] === null || cookies[k] === "") delete cookies[k];
    }
    if (Object.keys(cookies).length === 0) cookies = null;
  }
  return { cookies, source };
}

/** 读 surfcore 扫码登录写下的 credentials.json（键名是小写 sessdata/bili_jct/buvid3/mid）。 */
async function readSharedCredentials(env) {
  const dshHome = String(env.DSH_HOME ?? '').trim() || join(homedir(), ".dsh");
  const file = join(dshHome, "surfcore", "bili", "credentials.json");
  try {
    const obj = JSON.parse(await readFile(file, "utf8"));
    const out = {};
    if (obj.sessdata) out.SESSDATA = String(obj.sessdata);
    if (obj.bili_jct) out.bili_jct = String(obj.bili_jct);
    if (obj.buvid3) out.buvid3 = String(obj.buvid3);
    if (obj.buvid4) out.buvid4 = String(obj.buvid4);
    if (obj.mid) out.DedeUserID = String(obj.mid);
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

async function readCookieFile(path, { silent = false } = {}) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT" && silent) return null;
    throw new Error(`读不到 Cookie 文件：${path}（${err.code || err.message}）`);
  }
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    const obj = JSON.parse(trimmed);
    const out = {};
    for (const k of KEYS) if (obj[k]) out[k] = String(obj[k]).trim();
    return Object.keys(out).length ? out : null;
  }
  const fromNetscape = parseNetscapeCookies(text);
  if (Object.keys(fromNetscape).length) return fromNetscape;
  const fromHeader = parseCookieString(trimmed);
  return Object.keys(fromHeader).length ? fromHeader : null;
}

/** 保存 Cookie（0600），并刷新 buvid 缓存。 */
export async function saveCookies(cookies) {
  await writeJsonAtomic(FILES.cookies, cookies, { mode: 0o600 });
}
