import { test } from "node:test";
import assert from "node:assert/strict";

import { titleTokens, subtitleMismatch, estimateCost } from "../lib/pack.mjs";
import { fmtClock, fmtBytes } from "../lib/media.mjs";
import { slugify, buildFrontmatter, noteRelPath, dateOf } from "../lib/note.mjs";
import { parseCookieString, parseNetscapeCookies, hasLogin, redact } from "../lib/cookies.mjs";

test("titleTokens 同时抓英文词与中文 n-gram", () => {
  const t = titleTokens("DeepSeek 推理演示：DeepInfer 处理示例");
  assert.ok(t.includes("deepseek"));
  assert.ok(t.includes("deepinfer"));
  assert.ok(t.some((x) => /^[\u4e00-\u9fa5]{3}$/.test(x)));
  assert.ok(t.length <= 40);
});

test("字幕错轨：完全无关的正文判为可疑", () => {
  const title = "DeepSeek 推理演示：DeepInfer 处理示例";
  const travel = "[0:00-0:02] 今天我们要飞1500km\n[0:02-0:05] 去京都吃一顿怀石料理\n";
  const r = subtitleMismatch(title, travel);
  assert.equal(r.checked, true);
  assert.equal(r.suspicious, true);
});

test("字幕正常：命中标题片段就不算可疑", () => {
  const title = "DeepSeek 推理演示：DeepInfer 处理示例";
  const body = "[0:00-0:02] deepinfer 是什么\n[0:02-0:06] 它让 deepseek 推理更快更省\n";
  const r = subtitleMismatch(title, body);
  assert.equal(r.checked, true);
  assert.equal(r.suspicious, false);
  assert.ok(r.ratio > 0);
});

test("标题太短时不误判（返回 checked=false）", () => {
  const r = subtitleMismatch("猫", "喵喵喵");
  assert.equal(r.checked, false);
});

test("口水词也不该洗白错轨：命中率低 + 语速离群仍判可疑", () => {
  const title = "如何制作动画入门：颜色插值关键帧和镜头剪辑教程 VIBE";
  const body = "[0:00-0:03] 开场先说说如何制作咖啡\n[0:03-0:06] 准备磨好的豆子\n[0:06-0:09] 缓慢倒入热水\n";
  const r = subtitleMismatch(title, body, { charsPerSec: 10.28 });
  assert.equal(r.suspicious, true);
  assert.equal(r.reason, "rate-outlier");
});

test("标题里的英文名没被念出来，但字幕是对的：不判可疑", () => {
  const title = "聊聊机器人的模板对话 DSH";
  const body = "[0:00-0:04] 今天聊聊机器人\n[0:04-0:08] 模板对话可以用来演示\n[0:08-0:14] 接下来展示三个例子\n";
  const r = subtitleMismatch(title, body, { charsPerSec: 2.56 });
  assert.equal(r.ascii.hits, 0);
  assert.equal(r.suspicious, false);
});

test("低命中但内容正确：不算可疑", () => {
  const title = "六个常见 AI Agent 术语入门";
  const body = "[0:00-0:02] 看懂这六个术语\n[0:02-0:05] 就能理解它的流程\n[0:05-0:09] 大多数 agent 系统如何搭建\n";
  const r = subtitleMismatch(title, body);
  assert.equal(r.suspicious, false);
  assert.ok(r.ascii.hits >= 1);
});

test("ASCII 词按词边界匹配：said/again 里的 ai 不算命中", () => {
  const title = "用 dsh 把 bot 部署到云端";
  const body = "[0:00-0:03] He said again that the detail is irrelevant\n[0:03-0:06] The bear beckons\n";
  const r = subtitleMismatch(title, body);
  assert.equal(r.ascii.hits, 0);
  assert.equal(r.suspicious, true);
  assert.equal(r.reason, "ascii-miss");
});

test("纯中文标题：4-gram 一个都没出现判可疑", () => {
  const title = "一段工人文学发展史";
  const body = "[0:00-0:03] 今天聊聊手机芯片\n[0:03-0:06] 还有屏幕的调光方案\n";
  const r = subtitleMismatch(title, body);
  assert.equal(r.suspicious, true);
  assert.equal(r.reason, "cjk-miss");
});

test("fmtClock / fmtBytes", () => {
  assert.equal(fmtClock(0), "0:00");
  assert.equal(fmtClock(65), "1:05");
  assert.equal(fmtClock(3661), "1:01:01");
  assert.equal(fmtBytes(1024), "1 KB");
  assert.equal(fmtBytes(1048576), "1.0 MB");
});

test("slugify 去掉 Windows 非法字符并截断", () => {
  assert.equal(slugify('a/b:c*d?"e'), "a b c d e");
  assert.ok(slugify("长".repeat(100)).length <= 70);
  assert.equal(slugify(""), "untitled");
});

test("frontmatter：数字不加引号，中文加引号", () => {
  const fm = buildFrontmatter({ bvid: "BV1xx", duration: 190, title: "标题", tags: ["a", "b"] });
  assert.match(fm, /^---\n/);
  assert.match(fm, /duration: 190/);
  assert.match(fm, /title: "标题"/);
  assert.match(fm, /tags: \[a, b\]/);
});

test("noteRelPath 按收藏时间分目录", () => {
  const p = noteRelPath({ folderTitle: "默认收藏夹", favTime: 1761500000, title: "某个视频" });
  assert.match(p, /^10-视频[\\/]默认收藏夹[\\/]\d{4}-\d{2}-\d{2}-某个视频\.md$/);
});

test("dateOf 处理空值", () => {
  assert.match(dateOf(null), /^\d{4}-\d{2}-\d{2}$/);
});

test("Cookie 解析：header 串与 Netscape 格式", () => {
  const c = parseCookieString("SESSDATA=abc; bili_jct=def; DedeUserID=123; buvid3=XYZ");
  assert.equal(c.SESSDATA, "abc");
  assert.equal(c.DedeUserID, "123");
  const ns = parseNetscapeCookies("# Netscape\n.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tabc123\n");
  assert.equal(ns.SESSDATA, "abc123");
  assert.equal(hasLogin({ SESSDATA: "0123456789abc" }), true);
  assert.equal(hasLogin(null), false);
  const r = redact({ SESSDATA: "abcdefghijkl" });
  assert.ok(!String(r.SESSDATA).includes("abcdefghijkl"));
});

test("estimateCost 随片长增长", () => {
  const a = estimateCost({ duration: 300 });
  const b = estimateCost({ duration: 3600 });
  assert.ok(b.mb > a.mb);
  assert.ok(b.sheets >= a.sheets);
});
