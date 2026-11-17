import { readFile, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { UserInputError } from "./errors.mjs";

export async function readJson(file, fallback = null) {
  try {
    const bytes = await readFile(file);
    // Windows PowerShell 5 Out-File uses UTF-16LE; editors also emit UTF-8 BOM.
    const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe;
    const raw = bytes.toString(utf16 ? "utf16le" : "utf8").replace(/^\uFEFF/, "");
    try { return JSON.parse(raw); }
    catch (cause) {
      // Do not echo JSON fragments: other callers may be reading credentials.
      throw new UserInputError(`JSON 文件格式无效：${file}`, { cause, hint: "请检查引号、逗号及 JSON 语法；支持 UTF-8 和带 BOM 的 UTF-16LE" });
    }
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

/** 先写临时文件再 rename，避免中断留下半个 JSON。 */
export async function writeJsonAtomic(file, value, { mode } = {}) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const body = JSON.stringify(value, null, 2) + "\n";
  await writeFile(tmp, body, { encoding: "utf8", mode });
  try {
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function writeTextAtomic(file, text, { mode } = {}) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text, { encoding: "utf8", mode });
  try {
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
