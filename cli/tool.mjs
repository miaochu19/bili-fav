import { text } from 'node:stream/consumers'
import { createToolRuntime, toolError } from '../lib/tool-runtime.mjs'

const runtime = createToolRuntime()
const [action, name, input, ...extra] = process.argv.slice(2)

try {
  let result
  if (action === 'list' && name === undefined) {
    result = { tools: runtime.catalog }
  } else if (action === 'call' && name && extra.length === 0) {
    const json = input === '-' ? await text(process.stdin) : input ?? '{}'
    let args
    try {
      args = JSON.parse(json)
    } catch {
      throw new Error('工具参数必须是有效的 JSON 对象')
    }
    result = await runtime.call(name, args)
  } else {
    throw new Error('用法：node cli/tool.mjs list 或 node cli/tool.mjs call <工具名> [JSON | -]')
  }
  console.log(JSON.stringify(result))
} catch (error) {
  console.log(JSON.stringify(toolError(error)))
  process.exitCode = 1
}
