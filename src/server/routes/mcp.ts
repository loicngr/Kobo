import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { EXTERNAL_MCP_TOOLS } from '../../shared/workspace-dialogue-tools.js'
import { createMcpClientContext } from '../services/mcp-client-context.js'
import { executeWorkspaceDialogueTool } from '../services/workspace-dialogue-service.js'

const app = new Hono()
app.use('*', bodyLimit({ maxSize: 1024 * 1024 }))
app.all('/', async (c) => {
  const server = new Server({ name: 'kobo-workspaces', version: '1.0.0' }, { capabilities: { tools: {} } })
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: EXTERNAL_MCP_TOOLS }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const source = createMcpClientContext(
        c.req.header('X-Kobo-Client-Name'),
        c.req.header('X-Kobo-Client-Transport') === 'stdio' ? 'stdio' : 'http',
        c.req.header('X-Kobo-Client-Name-Encoding'),
      )
      const data = await executeWorkspaceDialogueTool(request.params.name, request.params.arguments ?? {}, source)
      const structuredContent =
        data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined
      return {
        content: [{ type: 'text', text: JSON.stringify(data) }],
        ...(structuredContent ? { structuredContent } : {}),
        ...(structuredContent?.accepted === false ? { isError: true } : {}),
      }
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      }
    }
  })
  try {
    await server.connect(transport)
    return await transport.handleRequest(c.req.raw)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500)
  } finally {
    await server.close()
  }
})
export default app
