// 用真实 DSH 的 schema 校验器（受限 JSON Schema 子集）验证插件注册的工具定义。
// 不消耗模型 API，不联网。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const manifest = process.env.BILI_FAV_DSH_PACKAGE
  || join(process.env.APPDATA || '', 'npm/node_modules/@deepseek-ai/dsh/package.json')
const req = createRequire(manifest)
const tools = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-tools')).href)

const { apply } = await import('../plugin/index.js')
const entries = []
apply({ tools: { register: (t) => entries.push(t) } }, {})

for (const t of entries) {
  tools.assertSupportedJsonSchema(t.parameters)
  tools.assertSupportedJsonSchema(t.output.schema)
  console.log(`schema ok: ${t.name}`)
}
console.log(`checked ${entries.length} tools`)

// 输出值也必须能通过 schema 校验
const sample = { ok: true, data: { total: 1, nested: [{ a: null }] } }
for (const t of entries) {
  const errors = tools.validateJsonSchemaValue(t.output.schema, sample)
  if (errors.length) throw new Error(`${t.name} output schema rejects sample: ${errors.join('; ')}`)
}
console.log('output sample ok')
