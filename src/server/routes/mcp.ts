import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { EXTERNAL_MEMORY_TOOL_DEFINITIONS, isMemoryToolName } from '../../shared/memory-tools.js'
import {
  isWorkspaceCreationTool,
  MAX_MCP_CREATION_REQUEST_BYTES,
  WORKSPACE_CREATION_TOOLS,
} from '../../shared/workspace-creation-tools.js'
import { EXTERNAL_MCP_TOOLS } from '../../shared/workspace-dialogue-tools.js'
import {
  isWorkspaceGroupMessageTool,
  WORKSPACE_GROUP_MESSAGE_TOOLS,
} from '../../shared/workspace-group-message-tools.js'
import { isWorkspaceLifecycleTool, WORKSPACE_LIFECYCLE_TOOLS } from '../../shared/workspace-lifecycle-tools.js'
import { createMcpClientContext } from '../services/mcp-client-context.js'
import { executeMemoryMcpTool } from '../services/memory-mcp-service.js'
import { executeWorkspaceCreationTool, WorkspaceCreationMcpError } from '../services/workspace-creation-mcp-service.js'
import { executeWorkspaceDialogueTool } from '../services/workspace-dialogue-service.js'
import {
  executeWorkspaceGroupMessageTool,
  WorkspaceGroupMessageMcpError,
} from '../services/workspace-group-message-mcp-service.js'
import {
  executeWorkspaceLifecycleTool,
  WorkspaceLifecycleMcpError,
} from '../services/workspace-lifecycle-mcp-service.js'
import { prepareMemoryToolEnvelope } from '../utils/memory-token-budget.js'

const app = new Hono()
// Only creation envelopes may carry the larger, base64 attachment payload.
// Other tools retain their existing 1 MiB limit, including malformed envelopes.
app.use('*', bodyLimit({ maxSize: MAX_MCP_CREATION_REQUEST_BYTES }))
app.use('*', async (c, next) => {
  if (c.req.raw.body) {
    const body = await c.req.raw.clone().arrayBuffer()
    if (body.byteLength > 1024 * 1024) {
      let creation = false
      try {
        const envelope = JSON.parse(new TextDecoder().decode(body))
        creation = envelope?.method === 'tools/call' && envelope?.params?.name === 'create_workspace'
      } catch {
        /* Preserve the normal body-size rejection for malformed input. */
      }
      if (!creation) return c.json({ error: 'MCP request is too large' }, 413)
    }
  }
  return next()
})

/** Dispatch only the supported MCP operations through the existing UI handlers. */
async function dispatchWorkspaceRequest(pathname: string, init: RequestInit): Promise<Response> {
  if (pathname === '/api/workspaces/archived')
    throw new Error('Bulk operations are not supported by workspace MCP tools')
  const isWorkspaceOperation =
    (init.method === 'POST' &&
      (pathname === '/api/workspaces' ||
        /^\/api\/workspaces\/[^/]+\/(unarchive|archive|purge-worktree|restore-worktree)$/.test(pathname))) ||
    ((init.method === 'GET' || init.method === 'DELETE') && /^\/api\/workspaces\/[^/]+$/.test(pathname))
  if (isWorkspaceOperation) {
    const { default: routes } = await import('./workspaces.js')
    return routes.request(`http://kobo.internal${pathname.slice('/api/workspaces'.length) || '/'}`, init)
  }
  if (
    init.method === 'POST' &&
    (pathname === '/api/pull-requests/diagnose' || pathname === '/api/pull-requests/resolve')
  ) {
    const { default: routes } = await import('./pull-requests.js')
    return routes.request(`http://kobo.internal${pathname.slice('/api/pull-requests'.length)}`, init)
  }
  throw new Error('Unsupported workspace operation')
}
app.all('/', async (c) => {
  const server = new Server({ name: 'kobo-workspaces', version: '1.0.0' }, { capabilities: { tools: {} } })
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MAX_MCP_CREATION_REQUEST_BYTES,
  })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...EXTERNAL_MCP_TOOLS,
      ...WORKSPACE_CREATION_TOOLS,
      ...WORKSPACE_LIFECYCLE_TOOLS,
      ...WORKSPACE_GROUP_MESSAGE_TOOLS,
      ...EXTERNAL_MEMORY_TOOL_DEFINITIONS,
    ],
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
        : isWorkspaceCreationTool(request.params.name)
          ? await executeWorkspaceCreationTool(
              request.params.name,
              request.params.arguments ?? {},
              dispatchWorkspaceRequest,
            )
          : isWorkspaceLifecycleTool(request.params.name)
            ? await executeWorkspaceLifecycleTool(
                request.params.name,
                request.params.arguments ?? {},
                dispatchWorkspaceRequest,
              )
            : isWorkspaceGroupMessageTool(request.params.name)
              ? executeWorkspaceGroupMessageTool(request.params.name, request.params.arguments ?? {}, source)
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
      if (error instanceof WorkspaceGroupMessageMcpError) {
        const data = { error: error.message, status: error.status }
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }
      }
      if (error instanceof WorkspaceCreationMcpError || error instanceof WorkspaceLifecycleMcpError) {
        const data = { error: error.message, status: error.status, stage: error.stage, details: error.details }
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }
      }
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
