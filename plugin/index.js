/** DSH 适配器。工具定义和参数校验也供 MCP 与 JSON CLI 使用。 */
export const name = 'dsh-bili-fav-plugin'
export const inject = ['tools']

import { createBiliTools, dshSchemaProperties } from './tools.mjs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'

const defaults = {
  projectRoot: '',
  timeoutMs: 30 * 60 * 1000,
}

let opsModule
function loadOps(projectRoot) {
  const root = typeof projectRoot === 'string' && projectRoot.trim() ? projectRoot.trim() : null
  // 允许用 projectRoot 指定数据根（测试/插件被复制安装时）；
  // 只有该根下真的有 lib/ops.mjs 才从绝对路径加载，否则用插件旁边的引擎。
  if (root) process.env.BILI_FAV_HOME = root
  const absolute = root && existsSync(join(root, 'lib', 'ops.mjs'))
  opsModule ??= absolute
    ? import(pathToFileURL(join(root, 'lib', 'ops.mjs')).href)
    : import('../lib/ops.mjs')
  return opsModule
}

export function apply(ctx, config = {}) {
  const settings = { ...defaults, ...config }
  const timeoutMs = Number.isFinite(settings.timeoutMs) && settings.timeoutMs > 0 ? settings.timeoutMs : defaults.timeoutMs
  for (const tool of createBiliTools({ getOps: () => loadOps(settings.projectRoot), timeoutMs })) {
    const parameters = { ...tool.parameters, properties: dshSchemaProperties(tool.parameters.properties) }
    ctx.tools.register({ ...tool, parameters })
  }
}
