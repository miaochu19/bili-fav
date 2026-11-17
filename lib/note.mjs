import { join } from "node:path";
import { mkdir, copyFile, writeFile } from "node:fs/promises";

import { VAULT, FILES } from "./paths.mjs";
import { readJson, writeJsonAtomic, writeTextAtomic } from "./fsx.mjs";
import { fmtClock } from "./media.mjs";

export async function archiveCover(packet, { vault = VAULT } = {}) {
  if (!packet.view?.pic) return null;
  const response = await fetch(packet.view.pic, { headers: { Referer: "https://www.bilibili.com/" }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`封面下载失败 HTTP ${response.status}`);
  const mime = (response.headers.get("content-type") || "").split(";")[0];
  const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[mime];
  if (!ext) throw new Error(`封面格式不支持：${mime || "未知"}`);
  const target = join("90-素材", packet.bvid, `cover.${ext}`);
  await mkdir(join(vault, "90-素材", packet.bvid), { recursive: true });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) throw new Error("封面为空");
  await writeFile(join(vault, target), bytes);
  return target.replace(/\\/g, "/");
}

const BAD = /[\\/:*?"<>|\r\n\t]+/g;

export function slugify(title, max = 70) {
  const s = String(title || "untitled")
    .replace(BAD, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (s.length > max ? s.slice(0, max).trim() : s) || "untitled";
}

export function dateOf(unix) {
  if (!unix) return new Date().toISOString().slice(0, 10);
  return new Date(Number(unix) * 1000).toISOString().slice(0, 10);
}

export function yamlValue(v) {
  if (Array.isArray(v)) return `[${v.map((x) => yamlScalar(x)).join(", ")}]`;
  return yamlScalar(v);
}

function yamlScalar(v) {
  if (typeof v === "boolean") return String(v);
  const s = String(v ?? "");
  if (s === "") return '""';
  if (/^-?\d+(\.\d+)?$/.test(s)) return s; // 数字不引号
  if (/^[A-Za-z0-9_./:-]+$/.test(s) && !/^(true|false|null|yes|no)$/i.test(s)) return s;
  return JSON.stringify(s);
}

export function buildFrontmatter(fields) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    lines.push(`${k}: ${yamlValue(v)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

export function noteRelPath({ folderTitle, favTime, title }) {
  const folder = slugify(folderTitle || "未归类", 40);
  const name = `${dateOf(favTime)}-${slugify(title)}`;
  return join("10-视频", folder, `${name}.md`);
}

/** 笔记与索引的元数据仓库（以 bvid 为键）。 */
export async function loadNotes() {
  return (await readJson(FILES.notes, {})) || {};
}

export async function saveNotes(notes) {
  await writeJsonAtomic(FILES.notes, notes);
}

export async function writeNote({ packet, body, tags = [], rating = null, status = "summarized", assets = [], summaryDepth, noteKind = "summary", budgetOverride = false, evidenceBasis = "transcript", watched = true }) {
  const relPath = noteRelPath({
    folderTitle: packet.fav?.folderTitle,
    favTime: packet.fav?.favTime || packet.view?.pubdate,
    title: packet.view?.title,
  });
  const absPath = join(VAULT, relPath);
  await mkdir(join(absPath, ".."), { recursive: true });

  // 把拼图复制进库，笔记里用相对链接引用，库能整包搬走
  const assetLinks = [];
  const warnings = [];
  let cover = null;
  try { cover = await archiveCover(packet); }
  catch (err) { warnings.push(err.message); }
  for (const sheet of assets) {
    const targetRel = join("90-素材", packet.bvid, sheet.file.split(/[\\/]/).pop());
    const targetAbs = join(VAULT, targetRel);
    await mkdir(join(targetAbs, ".."), { recursive: true });
    await copyFile(sheet.file, targetAbs);
    assetLinks.push({ rel: targetRel, from: sheet.from, to: sheet.to });
  }

  const fm = buildFrontmatter({
    bvid: packet.bvid,
    title: packet.view?.title,
    up: packet.view?.owner?.name,
    up_mid: packet.view?.owner?.mid,
    duration: packet.view?.duration,
    duration_h: packet.view?.duration ? +(packet.view.duration / 3600).toFixed(2) : null,
    pubdate: dateOf(packet.view?.pubdate),
    fav_time: packet.fav?.favTime ? dateOf(packet.fav.favTime) : null,
    fav_folder: packet.fav?.folderTitle || "未归类",
    aid: packet.view?.aid,
    tags,
    rating,
    status,
    summary_depth: summaryDepth,
    note_kind: noteKind,
    // 依据来源必须落到 frontmatter：comments_only 表示"只看了评论，没看片"
    evidence_basis: evidenceBasis,
    watched,
    budget_override: budgetOverride || undefined,
    source_scope: packet.multiPart ? "first_part_only" : "single_video",
    page_count: packet.pageCount,
    visual_coverage: assets.length ? "sampled_material_available" : packet.materials?.transcript ? "text_only" : "not_recorded",
    transcript_sha256: packet.materials?.transcriptSha256,
    url: `https://www.bilibili.com/video/${packet.bvid}`,
    cover: cover || packet.view?.pic,
    cover_url: packet.view?.pic,
    multi_part: packet.multiPart || packet.view?.multiPart ? true : undefined,
    selected_page: packet.multiPart || packet.view?.multiPart ? 1 : undefined,
    summarized_at: new Date().toISOString(),
  });

  const sourceBlock = [
    "",
    "---",
    "",
    "## 原始素材",
    "",
    cover ? `- 封面：![[${cover}]]` : "",
    ...warnings.map((w) => `- 素材提示：${w}`),
    `- 字幕：${packet.materials?.transcript ? `\`${packet.materials.transcript}\`` : "无（或需登录）"}`,
    `- 拼图：${assetLinks.length ? assetLinks.map((a) => `![[${a.rel.replace(/\\/g, "/")}]]`).join(" ") : "未生成"}`,
    packet.materials?.audio ? `- 音频：\`${packet.materials.audio}\`` : "",
    packet.materials?.danmaku ? `- 弹幕峰值：\`${packet.materials.danmaku}\`` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const text = `${fm}\n\n${body.trim()}\n\n${sourceBlock.trim()}\n`;
  await writeTextAtomic(absPath, text);

  const notes = await loadNotes();
  notes[packet.bvid] = {
    bvid: packet.bvid,
    title: packet.view?.title,
    up: packet.view?.owner?.name,
    duration: packet.view?.duration,
    folder: packet.fav?.folderTitle || "未归类",
    favTime: packet.fav?.favTime || null,
    tags,
    rating,
    status,
    path: relPath.replace(/\\/g, "/"),
    updatedAt: new Date().toISOString(),
  };
  await saveNotes(notes);
  return { absPath, relPath: relPath.replace(/\\/g, "/"), warnings };
}

const STARS = ["", "★☆☆☆☆", "★★☆☆☆", "★★★☆☆", "★★★★☆", "★★★★★"];

/** 重建 00-索引/B站收藏夹.md。 */
export async function rebuildIndex({ favs }) {
  const notes = await loadNotes();
  const all = favs?.videos || [];
  const done = all.filter((v) => notes[v.bvid]);
  const pending = all.filter((v) => !notes[v.bvid] && !v.invalid);

  const totalH = all.reduce((s, v) => s + (v.duration || 0), 0) / 3600;
  const doneH = done.reduce((s, v) => s + (v.duration || 0), 0) / 3600;

  const lines = [
    "---",
    "type: moc",
    "title: B站收藏夹",
    `updated: ${new Date().toISOString().slice(0, 10)}`,
    "---",
    "",
    "# B 站收藏夹",
    "",
    `> 共 **${all.length}** 个视频（${totalH.toFixed(1)} 小时），已整理 **${done.length}** 个（${doneH.toFixed(1)} 小时）。`,
    `> 抓取时间：${favs?.generatedAt?.slice(0, 10) || "?"}　账号：${favs?.uname || "?"}`,
    "",
  ];

  // 按收藏夹分组
  const byFolder = new Map();
  for (const v of all) {
    const f = notes[v.bvid]?.folder || v.folders?.[0]?.title || "未归类";
    if (!byFolder.has(f)) byFolder.set(f, []);
    byFolder.get(f).push(v);
  }

  for (const [folder, vids] of [...byFolder].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`## ${folder}（${vids.length}）`, "");
    lines.push("| 视频 | UP | 时长 | 评级 | 标签 |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const v of vids) {
      const n = notes[v.bvid];
      const name = n ? `[[${n.path.replace(/\.md$/, "")}\\|${v.title}]]` : v.title;
      const rate = n?.rating ? STARS[n.rating] || n.rating : "—";
      const tags = n?.tags?.length ? n.tags.map((t) => `#${t}`).join(" ") : "";
      lines.push(`| ${name} | ${v.up || ""} | ${fmtClock(v.duration)} | ${rate} | ${tags} |`);
    }
    lines.push("");
  }

  if (pending.length) {
    lines.push(`## 待整理（${pending.length}）`, "");
    const list = pending
      .slice()
      .sort((a, b) => (b.favTime || 0) - (a.favTime || 0))
      .slice(0, 200);
    for (const v of list) lines.push(`- [ ] ${v.title} · ${v.up} · ${fmtClock(v.duration)}`);
    if (pending.length > 200) lines.push(`- …还有 ${pending.length - 200} 个`);
    lines.push("");
  }

  const out = join(VAULT, "00-索引", "B站收藏夹.md");
  await writeTextAtomic(out, lines.join("\n"));

  const tagsMap = new Map();
  for (const n of Object.values(notes)) {
    for (const t of n.tags || []) {
      if (!tagsMap.has(t)) tagsMap.set(t, []);
      tagsMap.get(t).push(n);
    }
  }
  const tagLines = ["---", "type: index", "title: 标签", "---", "", "# 标签", ""];
  for (const [t, list] of [...tagsMap].sort((a, b) => b[1].length - a[1].length)) {
    tagLines.push(`## ${t}（${list.length}）`, "");
    for (const n of list) tagLines.push(`- [[${n.path.replace(/\.md$/, "")}\\|${n.title}]]`);
    tagLines.push("");
  }
  await writeTextAtomic(join(VAULT, "00-索引", "标签.md"), tagLines.join("\n"));

  return { out, total: all.length, done: done.length, pending: pending.length, tags: tagsMap.size };
}
