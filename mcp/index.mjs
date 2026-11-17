import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createToolRuntime } from '../lib/tool-runtime.mjs'
import { createMcpServer } from './server.mjs'

const runtime = createToolRuntime()
const args = process.argv.slice(2)

try {
  if (args.length === 0) {
    const server = createMcpServer(runtime)
    await server.connect(new StdioServerTransport())
    process.stdin.once('end', () => { void server.close() })
  } else if (args.length === 1 && args[0] === '--http') {
    const { serveHttp } = await import('./http.mjs')
    await serveHttp(runtime, {
      port: Number(process.env.BILI_FAV_MCP_PORT ?? 3875),
      token: process.env.BILI_FAV_MCP_TOKEN,
      origin: process.env.BILI_FAV_MCP_ORIGIN,
    })
  } else {
    throw new Error('用法：node mcp/index.mjs [--http]')
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
