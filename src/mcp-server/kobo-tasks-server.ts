#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { MAX_MCP_ATTACHMENT_REQUEST_BYTES } from '../shared/mcp-attachments.js'
import { callWorkspaceDialogueTool, listWorkspaceDialogueTools } from './workspace-dialogue-client.js'

const workspaceId = process.env.KOBO_WORKSPACE_ID
const capability = process.env.KOBO_MCP_SESSION_TOKEN
const backendUrl = process.env.KOBO_BACKEND_URL ?? 'http://localhost:3000'
const server = new Server({ name: 'kobo-tasks', version: '1.0.0' }, { capabilities: { tools: {} } })

/** Managed processes never open SQLite or possess the administrator token. */
async function managedRequest(body: Record<string, unknown>) {
  if (!capability) throw new Error('Workspace tools require a current managed MCP launch capability')
  const response = await fetch(`${backendUrl.replace(/\/$/, '')}/api/internal-mcp`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json', 'X-Kobo-Mcp-Session': capability },
    body: JSON.stringify({ ...body, clientName: process.env.KOBO_MCP_CLIENT_NAME ?? server.getClientVersion()?.name }),
    signal: AbortSignal.timeout(15 * 60_000),
  })
  const result = await response.json()
  if (!response.ok && body.method === 'list') throw new Error('Managed MCP capability rejected')
  return result
}
server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (workspaceId) return managedRequest({ method: 'list' })
  return listWorkspaceDialogueTools(
    backendUrl,
    process.env.KOBO_MCP_TOKEN,
    process.env.KOBO_MCP_CLIENT_NAME ?? server.getClientVersion()?.name,
  )
})
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    if (workspaceId)
      return await managedRequest({
        method: 'call',
        name: request.params.name,
        arguments: request.params.arguments ?? {},
      })
    return await callWorkspaceDialogueTool(
      backendUrl,
      request.params.name,
      request.params.arguments ?? {},
      process.env.KOBO_MCP_TOKEN,
      process.env.KOBO_MCP_CLIENT_NAME ?? server.getClientVersion()?.name,
    )
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: error instanceof Error ? error.message : 'MCP request failed' }],
    }
  }
})
const transport = new StdioServerTransport(process.stdin, process.stdout, {
  maxBufferSize: MAX_MCP_ATTACHMENT_REQUEST_BYTES + 1,
})
server.connect(transport).catch(() => {
  console.error('[kobo-tasks-server] Transport failed')
  process.exit(1)
})
