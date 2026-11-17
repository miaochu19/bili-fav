import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js'
import { toolError } from '../lib/tool-runtime.mjs'

export function createMcpServer(runtime) {
  const server = new Server({ name: 'bili-fav', version: '0.1.0' }, { capabilities: { tools: {} } })

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: runtime.catalog }))
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
    const { name, arguments: args = {} } = params
    if (!runtime.has(name)) throw new McpError(ErrorCode.InvalidParams, `未知工具 ${name}`)
    try {
      const data = await runtime.call(name, args, signal)
      return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] }
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(toolError(error)) }] }
    }
  })
  server.onerror = (error) => console.error(error.message)
  return server
}
