import { createHash } from "node:crypto";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { readJson, writeJsonAtomic, writeTextAtomic } from "./fsx.mjs";
import { parseTranscript } from "./transcript.mjs";

export const digest = (value) => createHash("sha256").update(value).digest("hex");

/** Short-lived API material cache. Never stores cookies or raw player responses. */
export function materialStore(dir, { scope = "anonymous", refresh = false, offline = false, now = Date.now } = {}) {
  const stats = { hits: 0, misses: 0 }, pending = new Map();
  return {
    stats,
    // Explicit retention only: callers must label this potentially expired material.
    async peek(name, identity) {
      if (!/^[a-z0-9._-]+$/i.test(name)) throw new Error("无效缓存名称");
      const cached = await readJson(join(dir, `material.${name}.json`), null).catch(() => null);
      const key = digest(JSON.stringify({ scope, identity }));
      return cached?.version === 1 && (cached.key === key || offline && cached.identityKey === digest(JSON.stringify(identity)))
        ? { value: cached.value, at: cached.at } : null;
    },
    /** 只有"够新"的命中才算数：调用方要用它决定能不能省掉一次深翻页。 */
    async peekFresh(name, identity, ttl = 300_000) {
      const hit = await this.peek(name, identity);
      if (!hit) return null;
      if (!offline && !(now() - hit.at <= ttl)) return null;
      stats.hits++;
      return hit;
    },
    async get(name, identity, loader, { ttl = 300_000, fresh = false } = {}) {
      if (!/^[a-z0-9._-]+$/i.test(name)) throw new Error("无效缓存名称");
      const identityKey = digest(JSON.stringify(identity));
      const key = digest(JSON.stringify({ scope, identity })), file = join(dir, `material.${name}.json`);
      const cached = await readJson(file, null).catch(() => null);
      if ((!refresh && !fresh || offline) && cached?.version === 1 && (cached.key === key || offline && cached.identityKey === identityKey)
        && (offline || now() - cached.at <= ttl)) { stats.hits++; return cached.value; }
      if (offline) throw new Error(`离线缓存缺失/身份不匹配：${name}`);
      const jobKey = `${name}:${key}`;
      if (pending.has(jobKey)) return pending.get(jobKey);
      const job = (async () => {
        stats.misses++;
        const value = await loader();
        await writeJsonAtomic(file, { version: 1, key, identityKey, at: now(), value }, { mode: 0o600 });
        return value;
      })();
      pending.set(jobKey, job);
      try { return await job; } finally { pending.delete(jobKey); }
    },
  };
}

function sameVideo(meta, identity) {
  return meta?.bvid === identity.bvid && String(meta.cid) === String(identity.cid)
    && Math.abs(Number(meta.duration) - Number(identity.duration)) <= 1;
}

export async function readTranscriptCache(dir, identity, { modelKey, oldPacket } = {}) {
  const text = await readFile(join(dir, "transcript.txt"), "utf8").catch(() => null);
  if (!text) return null;
  const segments = parseTranscript(text);
  if (!segments.length || segments.some((s) => s.from < 0 || s.to > identity.duration + 1)) return null;
  const meta = await readJson(join(dir, "transcript.meta.json"), null).catch(() => null);
  if (meta) {
    if (meta.version !== 1 || !sameVideo(meta, identity) || meta.sha256 !== digest(text)) return null;
    if (meta.source === "asr" && meta.modelKey !== modelKey) return null;
    if (!["asr", "subtitle"].includes(meta.source)) return null;
    return { text, segments, meta, reused: true };
  }
  // Older packets can identify existing work; text headers alone cannot establish cid/P.
  if (!sameVideo({ bvid: oldPacket?.bvid, ...oldPacket?.view }, identity) || !text.slice(0, 400).includes(identity.bvid)) return null;
  const asr = Boolean(oldPacket.materials?.asr) && /本地转写/.test(text.slice(0, 200));
  if (asr && !text.slice(0, 200).includes(modelKey.split("|")[0])) return null;
  return { text, segments, reused: true, legacy: true, meta: { ...identity, version: 1,
    source: asr ? "asr" : "subtitle", modelKey: asr ? modelKey : null, sha256: digest(text),
    language: oldPacket.materials?.subtitleLang, subtitleCheck: oldPacket.materials?.subtitleCheck,
    discardedCount: oldPacket.materials?.asrDiscardedCount || 0,
    asrEvidence: oldPacket.materials?.asrEvidence || null } };
}

export async function saveTranscriptCache(dir, identity, { text, source, modelKey = null, language, subtitleCheck = null, discardedCount = 0, asrEvidence = null }) {
  const file = join(dir, "transcript.txt"), previous = await readFile(file, "utf8").catch(() => null);
  if (previous && previous !== text) {
    await writeTextAtomic(join(dir, `transcript.previous-${digest(previous).slice(0, 12)}.txt`), previous);
  }
  await writeTextAtomic(file, text);
  const meta = { version: 1, ...identity, source, modelKey, language, subtitleCheck, discardedCount, asrEvidence,
    sha256: digest(text), generatedAt: new Date().toISOString() };
  await writeJsonAtomic(join(dir, "transcript.meta.json"), meta);
  return meta;
}
