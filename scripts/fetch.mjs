// 下载器：Node 的 fetch 在本机可用（PowerShell 的 TLS 栈不行）。
// 用法：node scripts/fetch.mjs <url> <outPath>
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const [, , url, out] = process.argv;
if (!url || !out) {
  console.error("usage: node scripts/fetch.mjs <url> <outPath>");
  process.exit(2);
}

await mkdir(dirname(out), { recursive: true });

const res = await fetch(url, {
  headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  redirect: "follow",
});
if (!res.ok || !res.body) {
  console.error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  process.exit(1);
}

const total = Number(res.headers.get("content-length") || 0);
let seen = 0;
let lastPct = -1;

const body = Readable.fromWeb(res.body);
body.on("data", (chunk) => {
  seen += chunk.length;
  if (total) {
    const pct = Math.floor((seen / total) * 100);
    if (pct !== lastPct && pct % 10 === 0) {
      lastPct = pct;
      console.log(`  ${pct}% (${(seen / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB)`);
    }
  }
});

try {
  await pipeline(body, createWriteStream(out));
} catch (err) {
  await rm(out, { force: true }).catch(() => {});
  throw err;
}

console.log(`downloaded ${out} (${(seen / 1048576).toFixed(1)} MB)`);
