import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { createManagedMcpDispatcher } from '../../mcp-server/managed-mcp-dispatcher.js'
import { MAX_MCP_ATTACHMENT_REQUEST_BYTES } from '../../shared/mcp-attachments.js'
import { normalizeClientName } from '../../shared/workspace-message-types.js'
import { getDb } from '../db/index.js'
import { authorizeInternalMcpTool, resolveInternalMcpCapability } from '../services/internal-mcp-capability-service.js'
import { getSettingsPath } from '../utils/paths.js'

const app = new Hono()
app.use('*', async (c, next) => {
  try {
    resolveInternalMcpCapability(c.req.header('X-Kobo-Mcp-Session'))
  } catch {
    return c.json(
      { isError: true, content: [{ type: 'text', text: 'Invalid or revoked managed MCP capability' }] },
      403,
    )
  }
  return next()
})
app.use('*', bodyLimit({ maxSize: MAX_MCP_ATTACHMENT_REQUEST_BYTES }))
app.post('/', async (c) => {
  let input: { method?: unknown; name?: unknown; arguments?: unknown; clientName?: unknown }
  try {
    input = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return c.json({ error: 'Expected an object' }, 400)
  const token = c.req.header('X-Kobo-Mcp-Session')
  try {
    const capability = resolveInternalMcpCapability(token)
    const args = input.arguments ?? {}
    if (!args || typeof args !== 'object' || Array.isArray(args))
      return c.json({ error: 'Expected arguments object' }, 400)
    const name = typeof input.name === 'string' ? input.name : ''
    if (input.method !== 'list' && input.method !== 'call') return c.json({ error: 'Unknown operation' }, 400)
    if (input.method === 'call') authorizeInternalMcpTool(token, name, args as Record<string, unknown>)
    // Only attachment tools receive the larger envelope budget.
    if (
      name !== 'create_workspace' &&
      name !== 'send_workspace_message' &&
      new TextEncoder().encode(JSON.stringify(input)).byteLength > 1024 * 1024
    )
      return c.json({ error: 'Request too large' }, 413)
    const check = () => {
      if (input.method === 'call') authorizeInternalMcpTool(token, name, args as Record<string, unknown>)
      else resolveInternalMcpCapability(token)
    }
    const dispatch = async (pathname: string, init: RequestInit): Promise<Response> => {
      // All paths originate from the fixed managed-tool dispatcher. Reject path
      // traversal before URL normalization, including caller-supplied IDs.
      const requestPath = pathname.split('?')[0]
      if (requestPath.includes('..') || /[%\\#]/.test(requestPath)) throw new Error('Invalid managed request path')
      let routes: Hono
      let prefix: string
      if (pathname.startsWith('/api/workspaces/')) {
        routes = (await import('./workspaces.js')).default
        prefix = '/api/workspaces'
      } else if (pathname.startsWith('/api/dev-server/')) {
        routes = (await import('./dev-server.js')).default
        prefix = '/api/dev-server'
      } else if (pathname.startsWith('/api/memory/agent/')) {
        routes = (await import('./memory.js')).default
        prefix = '/api/memory'
      } else if (pathname.startsWith('/api/progress-bars/agent/')) {
        routes = (await import('./progress-bars.js')).default
        prefix = '/api/progress-bars'
      } else if (pathname.startsWith('/api/search?')) {
        routes = (await import('./search.js')).default
        prefix = '/api/search'
      } else throw new Error('Unsupported managed request')
      check()
      const relative = pathname.slice(prefix.length)
      return routes.request(`http://kobo.internal${relative.startsWith('?') ? '/' : ''}${relative}`, init)
    }
    const backendRequest = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', pathname: string, body?: unknown) => {
      const response = await dispatch(pathname, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (!response.ok) throw new Error(`Managed backend returned ${response.status}`)
      const text = await response.text()
      return text ? JSON.parse(text) : null
    }
    const dispatcher = createManagedMcpDispatcher({
      workspaceId: capability.workspaceId,
      db: getDb(),
      settingsPath: getSettingsPath(),
      backendUrl: 'http://kobo.internal',
      env: capability.env,
      backendRequest,
      fetcher: async (url, init) => dispatch(new URL(String(url)).pathname, init ?? {}),
      dialogueTool: async (_url, tool, arguments_) => {
        const { executeExternalMcpTool } = await import('./mcp.js')
        check()
        return executeExternalMcpTool(tool, arguments_ as Record<string, unknown>, {
          kind: 'mcp',
          clientName: normalizeClientName(
            typeof input.clientName === 'string' ? input.clientName : 'kobo-managed-agent',
          ),
          transport: 'stdio',
        })
      },
    })
    if (input.method === 'list')
      return c.json({
        tools: dispatcher.availableTools().filter((tool) => {
          try {
            authorizeInternalMcpTool(token, tool.name, {})
            return true
          } catch {
            return false
          }
        }),
      })
    check()
    return c.json(await dispatcher.callTool(name, args as Record<string, unknown>))
  } catch (error) {
    return c.json(
      {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : 'Managed MCP request rejected' }],
      },
      403,
    )
  }
})
export default app
