import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeSpeech, findRepeatedWindows, assessAsrEvidence, describeAsrEvidence } from "../lib/asr-review.mjs";
import { activityStats } from "../lib/loudness.mjs";

const seg = (from, to, text) => ({ from, to, text });

test("normalizeSpeech 去掉空白与中英标点", () => {
  assert.equal(normalizeSpeech(" 你好，世界！ "), "你好世界");
  assert.equal(normalizeSpeech("Hello, world."), "Helloworld");
});

test("正常口播：文本各不相同、有声音 → 不标记", () => {
  const segments = [
    seg(0, 3, "今天我们来聊聊怎么让模型看视频"),
    seg(3, 6, "第一种办法是均匀抽帧但是会漏画面"),
    seg(6, 9, "第二种是逐帧分析 token 消耗太大"),
    seg(9, 12, "所以先把变化的帧挑出来再喂模型"),
  ];
  const activity = { ok: true, activeRatio: 0.92, longestSilence: 0.5 };
  const out = assessAsrEvidence({ segments, duration: 12, activity });
  assert.equal(out.level, "none");
  assert.equal(describeAsrEvidence(out), null);
});

test("相邻重复（间隔 <2s）不算独立窗口，不判幻觉", () => {
  const line = "这段文字被切成了两段";
  const segments = [seg(0, 2, line), seg(2.5, 4, line), seg(4, 7, "后面是完全不同的内容")];
  const out = assessAsrEvidence({ segments, duration: 7, activity: { ok: true, activeRatio: 0.8, longestSilence: 0.5 } });
  assert.notEqual(out.level, "suspect");
});

test("独立窗口输出同一段文本且过半 → suspect", () => {
  const line = "字幕由某某字幕组制作提供";
  const segments = [seg(0, 3, line), seg(30, 33, line), seg(60, 63, "中间这句是真实语音内容"), seg(90, 93, line)];
  const out = assessAsrEvidence({ segments, duration: 93, activity: { ok: true, activeRatio: 0.9, longestSilence: 0.5 } });
  assert.equal(out.level, "suspect");
  assert.match(out.reasons.join(), /反复出现在隔开的时间窗/);
  assert.ok(findRepeatedWindows(segments).dupSegments >= 3);
});

test("声学侧几乎无声却转出字 → suspect", () => {
  const segments = [seg(0, 5, "本视频讲述了人工智能的发展历史"), seg(5, 10, "以及它对未来社会的影响")];
  const out = assessAsrEvidence({ segments, duration: 10, activity: { ok: true, activeRatio: 0.03, longestSilence: 9.2 } });
  assert.equal(out.level, "suspect");
  assert.match(out.reasons.join(), /声学侧只有/);
});

test("缺少声学证据时降为 review 并说明原因", () => {
  const segments = [seg(0, 3, "一段很正常的口播内容"), seg(3, 6, "没有任何重复的句子")];
  const out = assessAsrEvidence({ segments, duration: 6, activity: null });
  assert.equal(out.level, "review");
  assert.match(out.reasons.join(), /没有声学证据/);
});

test("单段模板句 → suspect", () => {
  const out = assessAsrEvidence({
    segments: [seg(0, 8, "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目")],
    duration: 8, activity: { ok: true, activeRatio: 0.5, longestSilence: 0.2 },
  });
  assert.equal(out.level, "suspect");
});

test("零星重复（不足 15%）不进提示，避免口头禅误报", () => {
  const segments = [];
  for (let i = 0; i < 40; i++) segments.push(seg(i, i + 1, `第${i}段不同的正常口播内容`));
  segments.push(seg(50, 51, "对对我说的就是这个意思")); // 间隔 <2s 之外的一次重复
  segments[0] = seg(0, 1, "对对我说的就是这个意思");
  segments[1] = seg(1, 2, "对对我说的就是这个意思");
  const out = assessAsrEvidence({ segments, duration: 51, activity: { ok: true, activeRatio: 0.9, longestSilence: 0.5 } });
  assert.equal(out.level, "none");
});

test("activityStats 从响度曲线算活跃度与最长静音", () => {
  const curve = [
    { at: 0, db: -60 }, { at: 0.5, db: -58 }, { at: 1, db: -30 },
    { at: 1.5, db: -20 }, { at: 2, db: -55 }, { at: 2.5, db: -19 },
  ];
  const st = activityStats(curve);
  assert.equal(st.ok, true);
  assert.equal(st.activeRatio, 0.5);
  assert.equal(st.longestSilence, 1);
  assert.equal(activityStats([]).ok, false);
});
