// 请求保护层：参考 dsh-bili-whale 的 traffic.mjs（MIT）思路，按我们自己的结构重写。
// 目标不是"绕过风控"，是别把账号往风控上撞：
//   ① 全局限速（进程内）  ② 命中风控码就熔断一段时间  ③ 每日请求预算
import { join } from "node:path";

import { DATA } from "./paths.mjs";
import { readJson, writeJsonAtomic, sleep } from "./fsx.mjs";

const BAN_FILE = join(DATA, "ban.json");

const state = {
  minIntervalMs: 900,      // 两次请求之间至少 0.9 秒（比原来的 1–1.8s 抖动更硬）
  dailyLimit: 4000,        // 进程内每日上限，防手滑全量跑
  lastAt: 0,
  day: new Date().toISOString().slice(0, 10),
  count: 0,
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** 每次请求前调用：熔断检查 → 限速 → 计数。skipDelay 只跳过等待，不跳过熔断。 */
export async function beforeRequest({ skipDelay = false } = {}) {
  const ban = await readJson(BAN_FILE, null).catch(() => null);
  if (ban?.until && Date.now() < ban.until) {
    const left = Math.ceil((ban.until - Date.now()) / 60000);
    throw new Error(`风控暂停中，还剩 ${left} 分钟（${ban.why || "412"}），先别硬顶`);
  }
  if (ban?.until && Date.now() >= ban.until) {
    await writeJsonAtomic(BAN_FILE, { until: 0, why: null, at: Date.now() }).catch(() => {});
  }

  if (!skipDelay) {
    const wait = state.minIntervalMs - (Date.now() - state.lastAt);
    if (wait > 0) await sleep(wait);
  }
  state.lastAt = Date.now();

  if (state.day !== today()) {
    state.day = today();
    state.count = 0;
  }
  state.count++;
  if (state.count > state.dailyLimit) {
    throw new Error(`今天已经发了 ${state.count} 次请求，超过上限 ${state.dailyLimit}；明天再来，或调 traffic 配置`);
  }
}

/**
 * 命中风控码后熔断。参考 bili-whale：412 是 IP 级限流，换接口救不了，只能停。
 * 第一次 5 分钟，之后每次翻倍，最长 30 分钟。
 */
export async function trip(reason) {
  const prev = await readJson(BAN_FILE, null).catch(() => null);
  const strikes = (prev?.strikes || 0) + 1;
  const minutes = Math.min(30, 5 * 2 ** (strikes - 1));
  await writeJsonAtomic(BAN_FILE, {
    until: Date.now() + minutes * 60000,
    why: reason,
    strikes,
    at: Date.now(),
  }).catch(() => {});
  return minutes;
}

/** 请求成功一次后清零连续风控计数。 */
export async function clearStrikes() {
  const prev = await readJson(BAN_FILE, null).catch(() => null);
  if (prev?.strikes) await writeJsonAtomic(BAN_FILE, { ...prev, strikes: 0 }).catch(() => {});
}

export function trafficState() {
  return { ...state, today: today() };
}

/** 测试/排障用：调参数或复位。 */
export function configure(patch = {}) {
  Object.assign(state, patch);
}
