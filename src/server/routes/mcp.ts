import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { EXTERNAL_MEMORY_TOOL_DEFINITIONS, isMemoryToolName } from '../../shared/memory-tools.js'
import { EXTERNAL_MCP_TOOLS } from '../../shared/workspace-dialogue-tools.js'
import { createMcpClientContext } from '../services/mcp-client-context.js'
import { executeMemoryMcpTool } from '../services/memory-mcp-service.js'
import { executeWorkspaceDialogueTool } from '../services/workspace-dialogue-service.js'
import { prepareMemoryToolEnvelope } from '../utils/memory-token-budget.js'

const app = new Hono()
app.use('*', bodyLimit({ maxSize: 1024 * 1024 }))
app.all('/', async (c) => {
  const server = new Server({ name: 'kobo-workspaces', version: '1.0.0' }, { capabilities: { tools: {} } })
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...EXTERNAL_MCP_TOOLS, ...EXTERNAL_MEMORY_TOOL_DEFINITIONS],
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const isMemory = isMemoryToolName(request.params.name)
    try {
      const source = createMcpClientContext(
        c.req.header('X-Kobo-Client-Name'),
        c.req.header('X-Kobo-Client-Transport') === 'stdio' ? 'stdio' : 'http',
        c.req.header('X-Kobo-Client-Name-Encoding'),
      )
      const data = isMemory
        ? executeMemoryMcpTool(request.params.name, request.params.arguments ?? {}, source)
        : await executeWorkspaceDialogueTool(request.params.name, request.params.arguments ?? {}, source)
      if (isMemory) {
        const bounded = prepareMemoryToolEnvelope(data, { targetTokens: 1_000, transport: 'external' })
        if (bounded.data.memoryOutputSuppressed === true) return { content: [], isError: true }
        const { __mcpError, ...publicData } = bounded.data
        return {
          content: [{ type: 'text', text: JSON.stringify(publicData) }],
          structuredContent: publicData,
          ...(__mcpError === true || publicData.budgetExhausted === true ? { isError: true } : {}),
        }
      }
      const structuredContent =
        data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined
      return {
        content: [{ type: 'text', text: JSON.stringify(data) }],
        ...(structuredContent ? { structuredContent } : {}),
        ...(structuredContent?.accepted === false ? { isError: true } : {}),
      }
    } catch (error) {
      if (isMemory) {
        const bounded = prepareMemoryToolEnvelope(
          {
            error: error instanceof Error ? error.message : String(error),
          },
          { targetTokens: 1_000, transport: 'external' },
        )
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(bounded.data) }],
          structuredContent: bounded.data,
        }
      }
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
