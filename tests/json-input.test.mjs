import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { readJson } from "../lib/fsx.mjs";
import { cliError } from "../lib/errors.mjs";

test("JSON input accepts editor UTF-8 BOM and PowerShell UTF-16LE BOM without altering string contents", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bili-json-"));
  t.after(async () => { if (!resolve(dir).startsWith(resolve(tmpdir()) + sep)) throw Error("Invalid fixture"); await rm(dir, { recursive: true, force: true }); });
  const value = { text: "中文\uFEFF保留正文内字符", version: 1 }, file = join(dir, "draft.json");
  for (const [text, encoding] of [[JSON.stringify(value), "utf8"], ["\uFEFF" + JSON.stringify(value), "utf8"], ["\uFEFF" + JSON.stringify(value), "utf16le"]]) {
    await writeFile(file, text, encoding); assert.deepEqual(await readJson(file), value);
  }
  assert.equal(await readJson(join(dir, "missing.json"), "fallback"), "fallback");
  await writeFile(file, '{"secret":"DO_NOT_ECHO",}');
  await assert.rejects(readJson(file), (err) => {
    assert.match(cliError(err), /JSON 文件格式无效.*draft.json/);
    assert.doesNotMatch(cliError(err), /DO_NOT_ECHO|\n\s+at /);
    assert.equal(err.cause.name, "SyntaxError");
    return true;
  });
});
