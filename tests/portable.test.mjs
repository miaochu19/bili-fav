import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const cli = fileURLToPath(new URL('../cli/tool.mjs', import.meta.url))
const entry = fileURLToPath(new URL('../mcp/index.mjs', import.meta.url))
const root = await mkdtemp(join(tmpdir(), 'bili-fav-portable-'))
const env = { ...process.env, BILI_FAV_HOME: root }
const target = 'BV1111111111'
const dir = join(root, 'data', 'cache', target)
const transcript = '首行🙂中文\n末行\n'
const names = ['bili_evidence', 'bili_feed', 'bili_find', 'bili_library', 'bili_note', 'bili_read']
const runCli = (args, input) => spawnSync(process.execPath, [cli, ...args], { env, input, encoding: 'utf8' })

before(async () => {
  await mkdir(dir, { recursive: true })
  await writeFile(join(root, 'data', 'favs.json'), JSON.stringify({ videos: [], folders: [] }))
  await writeFile(join(dir, 'packet.json'), JSON.stringify({
    bvid: target,
    view: { title: '离线视频', duration: 120 },
    materials: {
      transcript: join(dir, 'transcript.txt'),
      indexedTranscript: join(dir, 'transcript.indexed.txt'),
    },
    writing: { depth: 'shallow' },
  }))
  await writeFile(join(dir, 'transcript.txt'), '未编号原文')
  await writeFile(join(dir, 'transcript.indexed.txt'), transcript)
})

after(() => rm(root, { recursive: true, force: true }))

test('JSON CLI 列出同一套工具，接收 stdin 参数并用退出码报告失败', () => {
  const list = runCli(['list'])
  const { tools } = JSON.parse(list.stdout)
  assert.equal(list.status, 0)
  assert.deepEqual(tools.map(({ name }) => name).sort(), names)
  assert.equal(tools.find(({ name }) => name === 'bili_evidence').inputSchema.properties.limit.maximum, 8000)
  const stats = runCli(['call', 'bili_library', '-'], '{"action":"stats"}')
  assert.equal(stats.status, 0)
  assert.equal(JSON.parse(stats.stdout).data.total, 0)
  const invalid = runCli(['call', 'bili_note', '-'], JSON.stringify({
    action: 'write', target, bodyFile: 'data/cookies.json',
  }))
  assert.equal(invalid.status, 1)
  assert.match(JSON.parse(invalid.stdout).error, /未知参数 bodyFile/)
})

test('真实 MCP 客户端通过 stdio 握手、列工具、读证据并写入本地笔记', async (t) => {
  const client = new Client({ name: 'bili-fav-test', version: '1.0.0' })
  t.after(() => client.close())
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env }))
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map(({ name }) => name).sort(), names)
  assert.equal(tools.find(({ name }) => name === 'bili_note').inputSchema.properties.bodyFile, undefined)
  const stats = await client.callTool({ name: 'bili_library' })
  assert.equal(stats.structuredContent.data.total, 0)
  assert.deepEqual(JSON.parse(stats.content[0].text), stats.structuredContent)

  const evidence = async (offset, limit) => (await client.callTool({
    name: 'bili_evidence', arguments: { target, kind: 'transcript', offset, limit },
  })).structuredContent.data
  const first = await evidence(0, 3)
  assert.equal(first.text, '首行')
  assert.equal(first.nextOffset, 2)
  const second = await evidence(first.nextOffset, 100)
  assert.equal(first.text + second.text, transcript)
  assert.equal(second.nextOffset, null)

  const invalid = await client.callTool({ name: 'bili_evidence', arguments: { target, kind: 'transcript', limit: 8001 } })
  assert.equal(invalid.isError, true)
  assert.match(invalid.content[0].text, /8000/)

  const note = await client.callTool({
    name: 'bili_note',
    arguments: { action: 'write', target, body: '视频开场（0:10），随后进入正题（0:20），最后总结（0:30）。' },
  })
  assert.equal(note.structuredContent?.ok, true, JSON.stringify(note.content))
  assert.match(note.structuredContent.data.relPath, /\.md$/)
})

test('证据读取拒绝指向缓存之外的目录链接', async () => {
  const alias = 'BV2222222222'
  await symlink(dir, join(root, 'data', 'cache', alias), process.platform === 'win32' ? 'junction' : 'dir')
  const request = runCli(['call', 'bili_evidence', '-'], JSON.stringify({ target: alias, kind: 'transcript' }))
  assert.equal(request.status, 1)
  assert.match(JSON.parse(request.stdout).error, /超出该视频的缓存范围/)
})

test('真实 MCP 客户端通过 Streamable HTTP 调用，拒绝无凭据和意外 Origin', { timeout: 15000 }, async (t) => {
  const token = 'bili-fav-test-token-0123456789abcdef'
  const child = spawn(process.execPath, [entry, '--http'], {
    env: { ...env, BILI_FAV_MCP_PORT: '0', BILI_FAV_MCP_TOKEN: token },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  t.after(() => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')
    child.kill()
    return exited
  })
  const [output] = await once(child.stderr, 'data')
  const url = new URL(String(output).match(/http:\/\/127\.0\.0\.1:\d+\/mcp/)?.[0])
  const headers = { Authorization: `Bearer ${token}` }
  const protect = { signal: AbortSignal.timeout(3000) }
  assert.equal((await fetch(url, protect)).status, 401)
  assert.equal((await fetch(url, { ...protect, headers: { ...headers, Origin: 'https://unexpected.example' } })).status, 403)
  const client = new Client({ name: 'bili-fav-test', version: '1.0.0' })
  t.after(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }))
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map(({ name }) => name).sort(), names)
  const stats = await client.callTool({ name: 'bili_library' })
  assert.equal(stats.structuredContent.data.total, 0)
})
