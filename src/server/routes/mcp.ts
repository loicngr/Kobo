import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { MAX_MCP_ATTACHMENT_REQUEST_BYTES } from '../../shared/mcp-attachments.js'
import { isMemoryToolName } from '../../shared/memory-tools.js'
import { isProgressBarTool } from '../../shared/progress-bar-tools.js'
import { isWorkspaceCreationTool } from '../../shared/workspace-creation-tools.js'
import { isWorkspaceGroupMessageTool } from '../../shared/workspace-group-message-tools.js'
import { isWorkspaceLifecycleTool } from '../../shared/workspace-lifecycle-tools.js'
import type { MessageSource } from '../../shared/workspace-message-types.js'
import { getDb } from '../db/index.js'
import {
  authenticateExternalMcpToken,
  EXTERNAL_TOOL_CATALOGUE,
  type ExternalMcpPrincipal,
} from '../services/external-mcp-credentials-service.js'
import { createMcpClientContext } from '../services/mcp-client-context.js'
import { executeMemoryMcpTool } from '../services/memory-mcp-service.js'
import { resolveWorkspaceMemoryScope } from '../services/memory-service.js'
import { executeProgressBarTool, progressErrorData } from '../services/progress-bar-mcp-service.js'
import { ProgressBarError } from '../services/progress-bar-service.js'
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

function authenticateRequest(authorization = ''): ExternalMcpPrincipal | null {
  return authenticateExternalMcpToken(authorization.startsWith('Bearer ') ? authorization.slice(7) : '')
}

const app = new Hono()
app.use('*', async (c, next) => {
  if (!authenticateRequest(c.req.header('Authorization')))
    return c.json({ error: 'Dedicated MCP credential required' }, 401)
  c.header('Cache-Control', 'no-store')
  return next()
})
// Only creation and message envelopes may carry the larger, base64 attachment payload.
// Other tools retain their existing 1 MiB limit, including malformed envelopes.
app.use('*', bodyLimit({ maxSize: MAX_MCP_ATTACHMENT_REQUEST_BYTES }))
app.use('*', async (c, next) => {
  if (c.req.raw.body) {
    const body = await c.req.raw.clone().arrayBuffer()
    if (body.byteLength > 1024 * 1024) {
      let attachmentTool = false
      try {
        const envelope = JSON.parse(new TextDecoder().decode(body))
        attachmentTool =
          envelope?.method === 'tools/call' &&
          (envelope?.params?.name === 'create_workspace' ||
            (envelope?.params?.name === 'send_workspace_message' &&
              Array.isArray(envelope?.params?.arguments?.attachments) &&
              envelope.params.arguments.attachments.length > 0))
      } catch {
        /* Preserve the normal body-size rejection for malformed input. */
      }
      if (!attachmentTool) return c.json({ error: 'MCP request is too large' }, 413)
    }
  }
  // Uploads can outlive their credential. Never retain the pre-body principal.
  if (!authenticateRequest(c.req.header('Authorization')))
    return c.json({ error: 'Dedicated MCP credential required' }, 401)
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
    ((init.method === 'GET' || init.method === 'DELETE' || init.method === 'PATCH') &&
      /^\/api\/workspaces\/[^/]+$/.test(pathname))
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
  const currentPrincipal = (): ExternalMcpPrincipal => {
    const principal = authenticateRequest(c.req.header('Authorization'))
    if (!principal) throw new Error('MCP credential expired or revoked')
    return principal
  }
  const server = new Server({ name: 'kobo-workspaces', version: '1.0.0' }, { capabilities: { tools: {} } })
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MAX_MCP_ATTACHMENT_REQUEST_BYTES,
  })
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const principal = currentPrincipal()
    return { tools: EXTERNAL_TOOL_CATALOGUE.filter((tool) => canUseExternalMcpTool(principal, tool.name)) }
  })
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const source = createMcpClientContext(
      c.req.header('X-Kobo-Client-Name'),
      c.req.header('X-Kobo-Client-Transport') === 'stdio' ? 'stdio' : 'http',
      c.req.header('X-Kobo-Client-Name-Encoding'),
    )
    // This is the acceptance boundary: already-dispatched operations are not
    // cancelled on later revocation, but every new call reloads the live grant.
    return executeExternalMcpTool(request.params.name, request.params.arguments ?? {}, source, currentPrincipal())
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
export async function executeExternalMcpTool(
  name: string,
  args: Record<string, unknown>,
  source: MessageSource,
  principal?: ExternalMcpPrincipal,
) {
  const isMemory = isMemoryToolName(name)
  try {
    if (principal) args = authorizeExternalMcpCall(principal, name, args)
    let data = isProgressBarTool(name)
      ? executeProgressBarTool(name, args)
      : isMemory
        ? executeMemoryMcpTool(
            name,
            args,
            source,
            principal && !principal.allWorkspaces ? principal.workspaceIds : undefined,
          )
        : isWorkspaceCreationTool(name)
          ? await executeWorkspaceCreationTool(name, args, dispatchWorkspaceRequest)
          : isWorkspaceLifecycleTool(name)
            ? await executeWorkspaceLifecycleTool(name, args, dispatchWorkspaceRequest)
            : isWorkspaceGroupMessageTool(name)
              ? executeWorkspaceGroupMessageTool(name, args, source)
              : await executeWorkspaceDialogueTool(name, args, source)
    if (principal && !principal.allWorkspaces && name === 'list_workspaces' && Array.isArray(data)) {
      data = data.filter((workspace) => principal.workspaceIds.includes(workspace.id))
    }
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
    if (error instanceof ProgressBarError) {
      const data = progressErrorData(error)
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }
    }
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
}

export default app

const allWorkspaceOnly = new Set([
  'create_workspace',
  'diagnose_workspace_pr',
  'preview_workspace_group_message',
  'get_workspace_group_message',
])
export function canUseExternalMcpTool(principal: ExternalMcpPrincipal, name: string): boolean {
  return principal.tools.includes(name) && (principal.allWorkspaces || !allWorkspaceOnly.has(name))
}
export function authorizeExternalMcpCall(
  principal: ExternalMcpPrincipal,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const deny = () => {
    throw new Error('MCP credential does not authorize this operation')
  }
  if (!canUseExternalMcpTool(principal, name)) return deny()
  // Resource-wide grants still use each service's normal argument validation.
  if (principal.allWorkspaces) return args
  const definition = EXTERNAL_TOOL_CATALOGUE.find((tool) => tool.name === name)
  if (!definition || Object.keys(args).some((key) => !Object.hasOwn(definition.inputSchema.properties ?? {}, key)))
    return deny()
  if (name === 'list_workspaces') return args
  if (name === 'send_workspace_group_message') {
    if (
      !Array.isArray(args.workspace_ids) ||
      args.workspace_ids.some((id) => typeof id !== 'string' || !principal.workspaceIds.includes(id))
    )
      return deny()
    return args
  }
  if (isMemoryToolName(name)) {
    if (name === 'list_memory_scopes') {
      if (
        args.workspace_id !== undefined &&
        (typeof args.workspace_id !== 'string' || !principal.workspaceIds.includes(args.workspace_id))
      )
        return deny()
      return args
    }
    // Workspace aggregate memory also includes global/project entries. Restricted
    // keys use only the workspace-owned scope, never inherited memory.
    let scope: { id: string; workspace_id: string | null } | undefined
    if (typeof args.scope_id === 'string')
      scope = getDb()
        .prepare("SELECT id, workspace_id FROM memory_scopes WHERE id = ? AND level = 'workspace'")
        .get(args.scope_id) as typeof scope
    else if (typeof args.workspace_id === 'string' && principal.workspaceIds.includes(args.workspace_id)) {
      const resolved = resolveWorkspaceMemoryScope(args.workspace_id)
      scope = { id: resolved.id, workspace_id: args.workspace_id }
    }
    if (!scope?.workspace_id || !principal.workspaceIds.includes(scope.workspace_id)) return deny()
    const { workspace_id: _workspace, ...rest } = args
    return { ...rest, scope_id: scope.id }
  }
  if (typeof args.workspace_id !== 'string' || !principal.workspaceIds.includes(args.workspace_id)) return deny()
  return args
}
