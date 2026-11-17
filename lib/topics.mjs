export function validateModelAssignments(input, videos, rules) {
  const allowed = new Set([...rules.map((r) => r.name), "未分类"]);
  const ids = new Set(videos.map((v) => v.bvid));
  if (!input?.assign || typeof input.assign !== "object" || Array.isArray(input.assign)) throw new Error("模型文件格式应为 {assign: {BV号: 主题}}");
  for (const [bvid, topic] of Object.entries(input.assign)) {
    if (!ids.has(bvid) || !allowed.has(topic)) throw new Error(`无效分类：${bvid} → ${topic}（使用 prepare 输出的受控词表）`);
  }
  return input.assign;
}
