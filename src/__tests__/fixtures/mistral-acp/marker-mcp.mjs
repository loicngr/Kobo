// Synthetic stdio MCP for the opt-in native adapter smoke; no Kōbō credentials.
import { appendFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

appendFileSync(process.env.KOBO_PROBE_PIDS, `${process.pid}\n`)
const server = new McpServer({ name: 'kobo-probe', version: '1' })
server.registerTool('env_probe', { description: 'Return the synthetic launch marker' }, async () => ({
  content: [{ type: 'text', text: process.env.KOBO_PROBE_MARKER }],
}))
await server.connect(new StdioServerTransport())
