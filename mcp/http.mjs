import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpServer } from './server.mjs'

const hash = (value) => createHash('sha256').update(value).digest()

export async function serveHttp(runtime, { port, token, origin }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('BILI_FAV_MCP_PORT 必须是 0–65535 的整数')
  if (!token || !/^[\x21-\x7e]{32,}$/.test(token)) throw new Error('请将 BILI_FAV_MCP_TOKEN 设为至少 32 位的随机可见 ASCII 字符')
  const expected = hash(`Bearer ${token}`)
  const upstream = createServer(async (req, res) => {
    const sendStatus = (status, headers) => res.writeHead(status, headers).end()
    const port = upstream.address().port
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`]
    if (!hosts.includes(req.headers.host)) return sendStatus(403)
    const origins = [...hosts.map((host) => `http://${host}`), origin]
    if (req.headers.origin && !origins.includes(req.headers.origin)) return sendStatus(403)
    if (req.url !== '/mcp') return sendStatus(404)
    if (!timingSafeEqual(hash(req.headers.authorization ?? ''), expected)) {
      return sendStatus(401, { 'WWW-Authenticate': 'Bearer' })
    }

    const server = createMcpServer(runtime)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.once('close', () => { void server.close() })
    try {
      await server.connect(transport)
      // Limit authenticated HTTP requests before passing the JSON to the SDK.
      let body
      if (req.method === 'POST') {
        const chunks = []
        let size = 0
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          size += chunk.length
          if (size > 1024 * 1024) return sendStatus(413, { Connection: 'close' })
          chunks.push(chunk)
        }
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
          return
        }
      }
      await transport.handleRequest(req, res, body)
    } catch (error) {
      console.error(error.message)
      if (!res.headersSent) sendStatus(500)
      else res.end()
    }
  })
  await once(upstream.listen(port, '127.0.0.1'), 'listening')
  console.error(`Bili Fav MCP listening on http://127.0.0.1:${upstream.address().port}/mcp`)
  return upstream
}
