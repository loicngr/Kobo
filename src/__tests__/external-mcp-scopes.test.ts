import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import mcp from '../server/routes/mcp.js'
import {
  createExternalMcpCredential,
  revokeExternalMcpCredential,
} from '../server/services/external-mcp-credentials-service.js'
import { executeMemoryMcpTool } from '../server/services/memory-mcp-service.js'
import { executeProgressBarTool } from '../server/services/progress-bar-mcp-service.js'
import { executeWorkspaceDialogueTool } from '../server/services/workspace-dialogue-service.js'

vi.mock('../server/services/workspace-dialogue-service.js', () => ({
  executeWorkspaceDialogueTool: vi.fn(async () => [{ id: 'allowed' }, { id: 'private' }]),
}))
vi.mock('../server/services/progress-bar-mcp-service.js', () => ({
  executeProgressBarTool: vi.fn(),
  progressErrorData: vi.fn(),
}))
vi.mock('../server/services/memory-mcp-service.js', () => ({ executeMemoryMcpTool: vi.fn() }))
vi.mock('../server/db/index.js', () => ({
  getDb: () => ({
    prepare: () => ({
      get: (id: string) =>
        id === 'private-scope' ? { id, workspace_id: 'private' } : { id: 'allowed-scope', workspace_id: 'allowed' },
    }),
  }),
}))
let home: string
let previous: string | undefined
let token: string
beforeEach(() => {
  vi.clearAllMocks()
  previous = process.env.KOBO_HOME
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-mcp-scopes-'))
  process.env.KOBO_HOME = home
  token = createExternalMcpCredential({ name: 'reader', workspaceIds: ['allowed'] }).token
})
afterEach(() => {
  if (previous === undefined) delete process.env.KOBO_HOME
  else process.env.KOBO_HOME = previous
  fs.rmSync(home, { recursive: true, force: true })
})
async function rpc(method: string, params?: unknown, credential = token) {
  return mcp.request('http://localhost/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${credential}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  })
}
it('filters discovery and workspace data to the granted scope', async () => {
  const tools = await (await rpc('tools/list')).json()
  expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toContain('get_workspace')
  expect(tools.result.tools.map((tool: { name: string }) => tool.name)).not.toContain('send_workspace_message')
  expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toContain('list_memory_scopes')
  const listed = await (await rpc('tools/call', { name: 'list_workspaces', arguments: {} })).json()
  expect(JSON.parse(listed.result.content[0].text)).toEqual([{ id: 'allowed' }])
})
it.each([
  ['get_workspace', { workspace_id: 'private' }],
  ['get_workspace', { workspace_id: 'nonexistent' }],
  ['send_workspace_message', { workspace_id: 'allowed', content: 'write' }],
  ['get_workspace', { workspace_id: 'allowed', allWorkspaces: true }],
  ['list_progress_bars', { workspace_id: 'private', session_id: 'secret' }],
  ['read_memory', { scope_id: 'private-scope', entry_id: 'secret' }],
  ['list_memory_scopes', { workspace_id: 'private' }],
])('denies %s before resource dispatch', async (name, args) => {
  const response = await (await rpc('tools/call', { name, arguments: args })).json()
  expect(response.result.isError).toBe(true)
  expect(JSON.stringify(response.result)).toContain('does not authorize')
  expect(executeWorkspaceDialogueTool).not.toHaveBeenCalled()
  expect(executeMemoryMcpTool).not.toHaveBeenCalled()
  expect(executeProgressBarTool).not.toHaveBeenCalled()
})
it('requires a dedicated key even locally and rejects independently revoked and expired keys', async () => {
  expect((await rpc('tools/list', undefined, 'admin-token')).status).toBe(401)
  const issued = createExternalMcpCredential({
    name: 'short',
    allWorkspaces: true,
    expiresAt: new Date(Date.now() + 1000).toISOString(),
  })
  revokeExternalMcpCredential(issued.credential.id)
  expect((await rpc('tools/list', undefined, issued.token)).status).toBe(401)
  expect((await rpc('tools/list')).status).toBe(200)
  const expiring = createExternalMcpCredential({
    name: 'expiry',
    allWorkspaces: true,
    expiresAt: new Date(Date.now() + 1000).toISOString(),
  })
  vi.useFakeTimers()
  vi.setSystemTime(Date.now() + 2000)
  try {
    expect((await rpc('tools/list', undefined, expiring.token)).status).toBe(401)
  } finally {
    vi.useRealTimers()
  }
})

it.each([
  ['tools/list', 'revoked'],
  ['tools/call', 'revoked'],
  ['tools/list', 'expired'],
  ['tools/call', 'expired'],
])('rechecks %s credentials %s while a request body is still arriving', async (method, change) => {
  const now = Date.now()
  const issued = createExternalMcpCredential({
    name: 'slow request',
    workspaceIds: ['allowed'],
    expiresAt: new Date(now + 5_000).toISOString(),
  })
  let bodyStarted!: () => void
  const started = new Promise<void>((resolve) => {
    bodyStarted = resolve
  })
  let releaseBody!: () => void
  const released = new Promise<void>((resolve) => {
    releaseBody = resolve
  })
  const envelope = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method,
    ...(method === 'tools/call' ? { params: { name: 'get_workspace', arguments: { workspace_id: 'allowed' } } } : {}),
  })
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        bodyStarted()
        await released
        controller.enqueue(new TextEncoder().encode(envelope))
        controller.close()
      },
    },
    { highWaterMark: 0 },
  )
  const pending = mcp.fetch(
    new Request('http://localhost/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${issued.token}`,
      },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }),
  )
  await started
  const clock = change === 'expired' ? vi.spyOn(Date, 'now').mockReturnValue(now + 10_000) : undefined
  if (change === 'revoked') revokeExternalMcpCredential(issued.credential.id)
  releaseBody()
  try {
    const response = await pending
    expect(response.status).toBe(401)
    expect(executeWorkspaceDialogueTool).not.toHaveBeenCalled()
  } finally {
    clock?.mockRestore()
  }
})

it.each(['tools/list', 'tools/call'])('reloads %s authority at SDK dispatch after parsing', async (method) => {
  const issued = createExternalMcpCredential({ name: 'dispatch boundary', workspaceIds: ['allowed'] })
  const originalConnect = Server.prototype.connect
  const connect = vi.spyOn(Server.prototype, 'connect').mockImplementationOnce(async function (
    this: Server,
    transport,
  ) {
    await originalConnect.call(this, transport)
    revokeExternalMcpCredential(issued.credential.id)
  })
  try {
    const response = await rpc(
      method,
      method === 'tools/call' ? { name: 'get_workspace', arguments: { workspace_id: 'allowed' } } : undefined,
      issued.token,
    )
    const envelope = await response.json()
    expect(envelope.error).toBeDefined()
    expect(JSON.stringify(envelope)).toContain('expired or revoked')
    expect(executeWorkspaceDialogueTool).not.toHaveBeenCalled()
  } finally {
    connect.mockRestore()
  }
})
