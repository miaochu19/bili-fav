import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdirSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));

// 插件/测试可显式指定项目根；默认仍按本文件位置推算，行为不变。
export const ROOT = process.env.BILI_FAV_HOME ? resolve(process.env.BILI_FAV_HOME) : resolve(here, "..");
export const DATA = join(ROOT, "data");
export const CACHE = join(DATA, "cache");
export const LOGS = join(DATA, "logs");
export const VAULT = join(ROOT, "vault");
export const TOOLS = join(ROOT, "tools");
export const VENDOR = join(ROOT, "vendor");
export const BILI_WATCH = join(VENDOR, "bili-watch");

export const FILES = {
  cookies: join(DATA, "cookies.json"),
  buvid: join(DATA, "buvid.json"),
  favs: join(DATA, "favs.json"),
  state: join(DATA, "state.json"),
  notes: join(DATA, "notes.json"),
};

export function ensureDirs() {
  for (const d of [DATA, CACHE, LOGS, VAULT, TOOLS, VENDOR]) {
    mkdirSync(d, { recursive: true });
  }
}

/** 相对项目根的短路径，日志里用，避免打印用户名目录。 */
export function rel(p) {
  return p.startsWith(ROOT) ? p.slice(ROOT.length + 1) : p;
}
