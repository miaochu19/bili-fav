// 插件壳的离线测试：注册 / schema / 参数校验 / 只读 fixture。
// fixture 依赖 BILI_FAV_HOME 在 paths.mjs 首次加载前生效；
// 用 `npm run test:plugin` 独立进程跑能覆盖全部用例，run-all 同进程下只跑前两类。
import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'

const root = await mkdtemp(join(tmpdir(), 'bili-fav-plugin-test-'))
process.env.BILI_FAV_HOME = root

const { ROOT } = await import('../lib/paths.mjs')
const { apply } = await import('../plugin/index.js')
const isolated = ROOT === root

function registry(extra = {}) {
  const entries = []
  apply({ tools: { register: (t) => entries.push(t) }, ...extra }, { projectRoot: root })
  return entries
}

const entries = registry()
const byName = Object.fromEntries(entries.map((t) => [t.name, t]))
const call = (name, args, exec = {}) => byName[name].execute(args, exec)

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

before(async () => {
  // 收藏库 fixture
  await mkdir(join(root, 'data'), { recursive: true })
  await writeFile(join(root, 'data', 'favs.json'), JSON.stringify({
    generatedAt: '2026-01-01T00:00:00.000Z',
    mid: 1,
    uname: 'fixture',
    folders: [{ id: 1, title: '默认收藏夹', count: 2 }],
    videos: [
      { bvid: 'BV1111111111', title: '视频一', up: 'UP1', duration: 600, favTime: 1700000000, folders: [{ id: 1, title: '默认收藏夹' }], invalid: false },
      { bvid: 'BV2222222222', title: '视频二', up: 'UP2', duration: 1200, favTime: 1700000100, folders: [{ id: 1, title: '默认收藏夹' }], invalid: true },
    ],
  }), 'utf8')

  // 已有笔记 fixture（verify 用）
  const noteDir = join(root, 'vault', '10-视频', '默认收藏夹')
  await mkdir(noteDir, { recursive: true })
  await writeFile(join(noteDir, '2026-01-01-视频一.md'), [
    '---',
    'bvid: BV1111111111',
    'title: 视频一',
    'duration: 600',
    'evidence_basis: transcript',
    'watched: true',
    'note_kind: summary',
    'summary_depth: detailed',
    '---',
    '',
    '这是一条测试笔记正文。前面说了一件事（0:10），中间又补充了细节（0:20），最后给出结论（0:30）。',
    '',
    '## 原始素材',
    '',
    '- 字幕：`data/cache/BV1111111111/transcript.txt`',
    '',
  ].join('\n'), 'utf8')
  await writeFile(join(root, 'data', 'notes.json'), JSON.stringify({
    BV1111111111: {
      bvid: 'BV1111111111', title: '视频一', up: 'UP1', duration: 600,
      folder: '默认收藏夹', favTime: 1700000000, tags: ['测试'], rating: 4,
      path: '10-视频/默认收藏夹/2026-01-01-视频一.md', updatedAt: '2026-01-01T00:00:00.000Z',
    },
  }), 'utf8')

  // 素材包 fixture（write 用）：transcript 与指纹必须一致
  const cacheDir = join(root, 'data', 'cache', 'BV1111111111')
  await mkdir(cacheDir, { recursive: true })
  const transcript = '[00:00.000-00:10.000] 测试文本第一段\n[00:10.000-00:20.000] 测试文本第二段\n'
  await writeFile(join(cacheDir, 'transcript.txt'), transcript, 'utf8')
  await writeFile(join(cacheDir, 'packet.json'), JSON.stringify({
    bvid: 'BV1111111111',
    view: { title: '视频一', duration: 600, desc: '测试简介', pic: null, owner: { name: 'UP1', mid: 1 } },
    fav: { folderTitle: '默认收藏夹', favTime: 1700000000 },
    materials: {
      transcript: join(cacheDir, 'transcript.txt'),
      transcriptSha256: sha256(transcript),
      subtitleLang: 'ai-zh',
      subtitleCount: 2,
      comments: [],
      warnings: [],
      sheets: [],
      sheetsDir: null,
    },
    evidence: { basis: 'transcript', watched: false },
    writing: { depth: 'detailed' },
  }), 'utf8')
})

after(async () => {
  delete process.env.BILI_FAV_HOME
  await rm(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------- 注册与 schema

test('注册 5 个工具，schema 是对象根且有 description', () => {
  assert.deepEqual(entries.map((t) => t.name).sort(), ['bili_feed', 'bili_find', 'bili_library', 'bili_note', 'bili_read'])
  for (const t of entries) {
    assert.equal(t.parameters.type, 'object')
    assert.equal(t.parameters.additionalProperties, false)
    assert.ok(t.description.length > 10)
    assert.equal(t.output.schema.type, 'object')
    assert.deepEqual(t.output.schema.required, ['ok', 'data'])
    assert.ok(Number.isFinite(t.timeoutMs))
  }
})

test('输出渲染为 JSON 文本，不丢字段', () => {
  const content = byName.bili_library.output.render({}, { ok: true, data: { total: 2 } })
  assert.equal(content.length, 1)
  assert.equal(content[0].type, 'text')
  assert.match(content[0].text, /"total": 2/)
})

// ---------------------------------------------------------------- 参数校验（联网/读盘前）

test('参数校验在执行业务前拦下错误输入', async () => {
  await assert.rejects(call('bili_library', { action: 'nope' }), /不在支持的选项内/)
  await assert.rejects(call('bili_find', { query: '' }), /不能为空/)
  await assert.rejects(call('bili_find', { query: 'x', top: 0 }), /不能小于/)
  await assert.rejects(call('bili_read', { target: 'not-a-bv' }), /BV/)
  await assert.rejects(call('bili_read', { target: 'BV1111111111', maxAsrMinutes: 0 }), /不能小于/)
  await assert.rejects(call('bili_note', { action: 'write' }), /需要 target/)
  await assert.rejects(call('bili_note', { action: 'write', target: 'BV1111111111' }), /body/)
  await assert.rejects(call('bili_note', { action: 'nope' }), /不在支持的选项内/)
  await assert.rejects(call('bili_library', { bogus: 1 }), /未知参数/)
})

// ---------------------------------------------------------------- fixture 只读

test('stats 汇总总/有效/失效/笔记覆盖率', { skip: !isolated }, async () => {
  const { data } = await call('bili_library', { action: 'stats' })
  assert.equal(data.total, 2)
  assert.equal(data.valid, 1)
  assert.equal(data.invalid, 1)
  assert.equal(data.noted, 1)
  assert.equal(data.noteCoverage, 100)
  assert.equal(data.uname, 'fixture')
})

test('plan 排除已整理条目并给出预估', { skip: !isolated }, async () => {
  const { data } = await call('bili_library', { action: 'plan', n: 10 })
  assert.equal(data.done, 1)
  assert.equal(data.pending, 0)
  assert.equal(data.pool, 0)
})

test('verify 通过既有 fixture 笔记', { skip: !isolated }, async () => {
  const { data } = await call('bili_note', { action: 'verify', target: 'BV1111111111' })
  assert.equal(data.ok, true)
  assert.deepEqual(data.errors, [])
  assert.equal(data.timestamps.count, 3)
  assert.ok(data.chars > 0)
})

test('write 落盘并更新 notes.json，随后 verify 仍通过', { skip: !isolated }, async () => {
  const body = '这是一条测试笔记正文，用来验证写入流程。开头交代背景（0:10），中间补充细节（0:20），最后给出结论（0:30）。' +
    '继续写一些内容让正文长度更接近真实笔记，避免质检时被判定为偏短。这里的内容只是占位，不代表任何真实视频。' +
    '再补充几句：写入会经过时间戳审计、字数上限检查与素材指纹核对，任何一步失败都应该显式报错。' +
    '最后再加一句收尾，让正文凑够两百字以上，保证质检结果稳定可预期。'
  const { data } = await call('bili_note', { action: 'write', target: 'BV1111111111', body, tags: '测试,插件', rating: 4 })
  assert.match(data.relPath, /^10-视频\/默认收藏夹\//)
  assert.ok(data.absPath.endsWith('.md'))

  const verify = await call('bili_note', { action: 'verify', target: 'BV1111111111' })
  assert.equal(verify.data.ok, true)
  assert.deepEqual(verify.data.errors, [])
  assert.equal(verify.data.timestamps.count, 3)
})

test('write 拒绝超长正文，明确要求压缩', { skip: !isolated }, async () => {
  const longBody = '字'.repeat(1000) + '（0:10）（0:20）（0:30）'
  await assert.rejects(
    call('bili_note', { action: 'write', target: 'BV1111111111', body: longBody }),
    /超过上限/,
  )
})
