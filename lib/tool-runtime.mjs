import { createBiliTools } from '../plugin/tools.mjs'

export function createToolRuntime() {
  const tools = createBiliTools({ getOps: () => import('./ops.mjs'), portable: true })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const catalog = tools.map(({ name, description, parameters }) => ({ name, description, inputSchema: parameters }))
  // 同一个服务进程内，素材包、收藏目录和笔记索引由工具按顺序更新。
  let pending = Promise.resolve()

  return {
    catalog,
    has: (name) => byName.has(name),
    async call(name, args, signal) {
      const tool = byName.get(name)
      if (!tool) throw new Error(`未知工具 ${name}`)
      const result = pending.then(() => tool.execute(args, { signal }))
      pending = result.catch(() => {})
      return result
    },
  }
}

export function toolError(error) {
  return { ok: false, error: [error?.message || String(error), error?.hint].filter(Boolean).join('；') }
}
