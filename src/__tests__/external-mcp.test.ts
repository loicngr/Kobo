import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Hono } from 'hono'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { closeDb, getDb } from '../server/db/index.js'
import { runMigrations } from '../server/db/migrations.js'
import internalMcp from '../server/routes/internal-mcp.js'
import mcp from '../server/routes/mcp.js'
import {
  createExternalMcpCredential,
  EXTERNAL_TOOL_CATALOGUE,
} from '../server/services/external-mcp-credentials-service.js'
import { createInternalMcpCapability } from '../server/services/internal-mcp-capability-service.js'
import { executeWorkspaceDialogueTool } from '../server/services/workspace-dialogue-service.js'

vi.mock('../server/services/agent/orchestrator.js', () => ({
  getPendingInputs: vi.fn(() => []),
  answerPendingQuestion: vi.fn(),
}))
vi.mock('../server/services/workspace-message-service.js', () => ({
  deliverWorkspaceMessage: vi.fn(async () => ({ sessionId: 'session' })),
}))

import * as agent from '../server/services/agent/orchestrator.js'
import { deliverWorkspaceMessage } from '../server/services/workspace-message-service.js'

const reportRecord = vi.hoisted(() => ({ current: undefined as unknown }))
vi.mock('../server/routes/workspaces.js', async () => {
  const { Hono } = await import('hono')
  const reports = new Hono()
  reports.post('/:id/session-handoffs/:handoffId/report', async (c) => {
    reportRecord.current = { workspace: c.req.param('id'), handoff: c.req.param('handoffId'), body: await c.req.json() }
    return c.json({ accepted: true })
  })
  reports.post('/:id/auto-loop/final-review/report', async (c) => {
    reportRecord.current = { workspace: c.req.param('id'), body: await c.req.json() }
    return c.json({ ok: true })
  })
  return { default: reports }
})
let directory: string
let previousHome: string | undefined
let mcpToken: string
let managedToken: string
// These integration tests cold-start Node + tsx + the MCP server. Give both
// subprocess tests the same bounded allowance under the full CI worker load.
const STDIO_TEST_TIMEOUT_MS = 15_000
const app = new Hono().route('/api/mcp', mcp).route('/api/internal-mcp', internalMcp)
app.post('/api/workspaces/:id/stop', (c) => c.json({ token: c.req.header('X-Kobo-Token') ?? null }))
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(agent.getPendingInputs).mockReturnValue([])
  closeDb()
  directory = mkdtempSync(join(tmpdir(), 'kobo-external-mcp-'))
  previousHome = process.env.KOBO_HOME
  process.env.KOBO_HOME = directory
  mcpToken = createExternalMcpCredential({
    name: 'integration',
    allWorkspaces: true,
    tools: EXTERNAL_TOOL_CATALOGUE.map((tool) => tool.name),
  }).token
  managedToken = createInternalMcpCapability({ workspaceId: 'a', sessionId: 'session-a', readOnly: false }).token
  const db = getDb(join(directory, 'test.db'))
  runMigrations(db)
  for (const id of ['a', 'b'])
    db.prepare(
      "INSERT INTO workspaces(id,name,project_path,source_branch,working_branch,created_at,updated_at) VALUES (?,?,'/tmp','main','feature',datetime('now'),datetime('now'))",
    ).run(id, id)
})
afterEach(() => {
  closeDb()
  if (previousHome === undefined) delete process.env.KOBO_HOME
  else process.env.KOBO_HOME = previousHome
  rmSync(directory, { recursive: true, force: true })
})

it('supports initialization, discovery and tool calls through the SDK HTTP client', async () => {
  const client = new Client({ name: 'external-test', version: '1' })
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/api/mcp'), {
    fetch: async (input, init) => app.fetch(new Request(input, init)),
    requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } },
  })
  try {
    await client.connect(transport)
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toContain('send_workspace_message')
    const result = await client.callTool({ name: 'list_workspaces', arguments: {} })
    expect(result.isError).not.toBe(true)
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toMatchObject([
      { id: expect.any(String) },
      { id: expect.any(String) },
    ])
    const invalid = await client.callTool({
      name: 'send_workspace_message',
      arguments: { workspace_id: 'a', content: 42 },
    })
    expect(invalid.isError).toBe(true)
    expect(deliverWorkspaceMessage).not.toHaveBeenCalled()
  } finally {
    await client.close()
  }
})

it(
  'exposes the dialogue tools through the existing global stdio server',
  async () => {
    const listener = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
    if (!listener.listening) await new Promise<void>((resolve) => listener.once('listening', resolve))
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('Missing test listener address')
    const client = new Client({ name: 'Agent 工房 🤖', version: '1' })
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ['--import', 'tsx', 'src/mcp-server/kobo-tasks-server.ts'],
          env: {
            PATH: process.env.PATH ?? '',
            KOBO_HOME: directory,
            KOBO_WORKSPACE_ID: '',
            KOBO_DB_PATH: getDb().name,
            KOBO_BACKEND_URL: `http://127.0.0.1:${address.port}`,
            KOBO_MCP_TOKEN: mcpToken,
          },
          stderr: 'pipe',
        }),
      )
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('read_workspace_messages')
      const result = await client.callTool({ name: 'get_workspace', arguments: { workspace_id: 'b' } })
      expect(result.isError).not.toBe(true)
      expect(JSON.parse((result.content as { text: string }[])[0].text)).toMatchObject({ workspace: { id: 'b' } })
      const sent = await client.callTool({
        name: 'send_workspace_message',
        arguments: { workspace_id: 'b', content: 'hello' },
      })
      expect(sent.isError).not.toBe(true)
      expect(deliverWorkspaceMessage).toHaveBeenCalledWith(
        'b',
        expect.objectContaining({ source: { kind: 'mcp', clientName: 'Agent 工房 🤖', transport: 'stdio' } }),
      )
      const stopped = await client.callTool({ name: 'stop_workspace', arguments: { workspace_id: 'b' } })
      expect(stopped.isError).toBe(true)
    } finally {
      await client.close()
      await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())))
    }
  },
  STDIO_TEST_TIMEOUT_MS,
)

it('rejects oversized MCP requests before tool dispatch', async () => {
  const response = await app.request('/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mcpToken}` },
    body: 'x'.repeat(1024 * 1024 + 1),
  })
  expect(response.status).toBe(413)
  expect(deliverWorkspaceMessage).not.toHaveBeenCalled()
})

it('sends a durable message to the requested workspace and session', async () => {
  await executeWorkspaceDialogueTool('send_workspace_message', {
    workspace_id: 'b',
    content: 'please investigate',
    session_id: 's-b',
  })
  expect(deliverWorkspaceMessage).toHaveBeenCalledWith(
    'b',
    expect.objectContaining({ content: 'please investigate', sessionId: 's-b', clientMessageId: expect.any(String) }),
  )
})

it.each([
  ['get_workspace', { workspace_id: 'missing' }],
  ['read_workspace_messages', { workspace_id: 'a', limit: -1 }],
  ['send_workspace_message', { workspace_id: 'a', content: ' ' }],
  ['send_workspace_message', { workspace_id: 'a', content: 'hello', agent_permission_mode: 'bypass' }],
  ['answer_workspace_question', { workspace_id: 'a', tool_call_id: 'q', answers: [] }],
])('rejects invalid arguments for %s', async (name, args) => {
  await expect(executeWorkspaceDialogueTool(name, args)).rejects.toThrow()
})

it('reads conversation pages without leaking other workspaces or reusing their cursors', async () => {
  const insert = getDb().prepare(
    "INSERT INTO ws_events(id,workspace_id,type,payload,created_at) VALUES (?,?,'user:message',?,datetime('now'))",
  )
  insert.run('a-1', 'a', JSON.stringify({ content: 'first' }))
  insert.run('b-1', 'b', JSON.stringify({ content: 'private b' }))
  insert.run('a-2', 'a', JSON.stringify({ content: 'second' }))
  const first = await executeWorkspaceDialogueTool('read_workspace_messages', { workspace_id: 'a', limit: 1 })
  expect(first).toMatchObject({ messages: [{ id: 'a-1', text: 'first' }], nextCursor: 'a-1', hasMore: true })
  const second = await executeWorkspaceDialogueTool('read_workspace_messages', {
    workspace_id: 'a',
    after_cursor: 'a-1',
    limit: 1,
  })
  expect(second).toMatchObject({ messages: [{ id: 'a-2', text: 'second' }], hasMore: false })
  await expect(
    executeWorkspaceDialogueTool('read_workspace_messages', { workspace_id: 'a', after_cursor: 'b-1' }),
  ).rejects.toThrow('cursor')
})

it('only answers the exact pending question, never a permission request', async () => {
  vi.mocked(agent.getPendingInputs).mockReturnValue([
    { kind: 'permission', toolCallId: 'p', toolName: 'Edit', toolInput: {}, agentSessionId: 's' },
  ])
  await expect(
    executeWorkspaceDialogueTool('answer_workspace_question', {
      workspace_id: 'a',
      tool_call_id: 'p',
      answers: { q: 'yes' },
    }),
  ).rejects.toThrow('question')
  expect(agent.answerPendingQuestion).not.toHaveBeenCalled()
  vi.mocked(agent.getPendingInputs).mockReturnValue([
    { kind: 'question', toolCallId: 'q', toolName: 'AskUserQuestion', input: {}, agentSessionId: 's' },
  ])
  await expect(
    executeWorkspaceDialogueTool('answer_workspace_question', {
      workspace_id: 'a',
      tool_call_id: 'stale',
      answers: { choice: 'yes' },
    }),
  ).rejects.toThrow('current pending question')
  expect(agent.answerPendingQuestion).not.toHaveBeenCalled()
  await executeWorkspaceDialogueTool('answer_workspace_question', {
    workspace_id: 'a',
    tool_call_id: 'q',
    answers: { choice: 'yes' },
  })
  expect(agent.answerPendingQuestion).toHaveBeenCalledWith('a', { choice: 'yes' }, 'q', {
    source: { kind: 'mcp', clientName: 'External MCP client', transport: 'http' },
  })
})

it('reads streamed and legacy replies, filters sessions and advances past non-message events', async () => {
  const insert = getDb().prepare(
    "INSERT INTO ws_events(id,workspace_id,session_id,type,payload,created_at) VALUES (?,'a',?,?,?,datetime('now'))",
  )
  insert.run('status', 's', 'agent:status', '{}')
  insert.run('other-session', 'other', 'agent:event', JSON.stringify({ kind: 'message:text', text: 'excluded' }))
  insert.run('part-1', 's', 'agent:event', JSON.stringify({ kind: 'message:text', text: 'hel', messageId: 'reply' }))
  insert.run('part-2', 's', 'agent:event', JSON.stringify({ kind: 'message:text', text: 'lo', messageId: 'reply' }))
  insert.run(
    'legacy',
    null,
    'agent:output',
    JSON.stringify({ message: { content: [{ type: 'text', text: 'old reply' }] } }),
  )
  const args = { workspace_id: 'a', session_id: 's' }
  expect(await executeWorkspaceDialogueTool('read_workspace_messages', { ...args, limit: 1 })).toMatchObject({
    messages: [],
    nextCursor: 'status',
    hasMore: true,
  })
  expect(
    await executeWorkspaceDialogueTool('read_workspace_messages', { ...args, after_cursor: 'status' }),
  ).toMatchObject({
    messages: [
      { text: 'hel', messageId: 'reply', sessionId: 's' },
      { text: 'lo', messageId: 'reply', sessionId: 's' },
      { text: 'old reply', sessionId: null },
    ],
    nextCursor: 'legacy',
    hasMore: false,
  })
  expect(
    await executeWorkspaceDialogueTool('read_workspace_messages', { ...args, after_cursor: 'legacy' }),
  ).toMatchObject({ messages: [], nextCursor: 'legacy', hasMore: false })
  insert.run(
    'new',
    's',
    'agent:event',
    JSON.stringify({ kind: 'message:text', text: 'new reply', messageId: 'new-reply' }),
  )
  expect(
    await executeWorkspaceDialogueTool('read_workspace_messages', { ...args, after_cursor: 'legacy' }),
  ).toMatchObject({ messages: [{ text: 'new reply' }], nextCursor: 'new' })
})

it(
  'limits a handoff-generation MCP to reading and submitting its backend-bound report',
  async () => {
    const capability = createInternalMcpCapability({
      workspaceId: 'a',
      sessionId: 'handoff-session',
      readOnly: true,
      env: { KOBO_HANDOFF_ID: 'transfer-1', KOBO_HANDOFF_TOKEN: 'bound-token' },
    })
    const handoffApp = new Hono().route('/api/internal-mcp', internalMcp)
    const listener = serve({ fetch: handoffApp.fetch, hostname: '127.0.0.1', port: 0 })
    if (!listener.listening) await new Promise<void>((resolve) => listener.once('listening', resolve))
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('Missing listener')
    const client = new Client({ name: 'handoff-test', version: '1' })
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ['--import', 'tsx', 'src/mcp-server/kobo-tasks-server.ts'],
          env: {
            PATH: process.env.PATH ?? '',
            KOBO_DB_PATH: join(directory, 'test.db'),
            KOBO_WORKSPACE_ID: 'a',
            KOBO_MCP_SESSION_TOKEN: capability.token,
            KOBO_BACKEND_URL: `http://127.0.0.1:${address.port}`,
            KOBO_HANDOFF_ID: 'transfer-1',
            KOBO_HANDOFF_TOKEN: 'bound-token',
          },
        }),
      )
      const { tools } = await client.listTools()
      expect(tools.map((tool) => tool.name)).toContain('submit_session_handoff')
      expect(tools.map((tool) => tool.name)).not.toContain('mark_task_done')
      expect(tools.map((tool) => tool.name)).not.toContain('create_workspace')
      expect((await client.callTool({ name: 'create_workspace', arguments: {} })).isError).toBe(true)
      const blocked = await client.callTool({ name: 'create_task', arguments: { title: 'Do not mutate' } })
      expect(blocked.isError).toBe(true)
      const result = await client.callTool({
        name: 'submit_session_handoff',
        arguments: { report: '# Report', token: 'caller-spoof' },
      })
      expect(result.isError).not.toBe(true)
      expect(reportRecord.current).toEqual({
        workspace: 'a',
        handoff: 'transfer-1',
        body: { token: 'bound-token', report: '# Report' },
      })
    } finally {
      await client.close()
      await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())))
    }
  },
  STDIO_TEST_TIMEOUT_MS,
)

it(
  'limits a final-review MCP to reads and submits only its bound session capability',
  async () => {
    const capability = createInternalMcpCapability({
      workspaceId: 'a',
      sessionId: 'review-session',
      readOnly: true,
      env: { KOBO_FINAL_REVIEW_SESSION_ID: 'review-session', KOBO_FINAL_REVIEW_TOKEN: 'bound-token' },
    })
    const reportApp = new Hono().route('/api/internal-mcp', internalMcp)
    const listener = serve({ fetch: reportApp.fetch, hostname: '127.0.0.1', port: 0 })
    if (!listener.listening) await new Promise<void>((resolve) => listener.once('listening', resolve))
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('Missing listener')
    const client = new Client({ name: 'final-review-test', version: '1' })
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ['--import', 'tsx', 'src/mcp-server/kobo-tasks-server.ts'],
          env: {
            PATH: process.env.PATH ?? '',
            KOBO_DB_PATH: join(directory, 'test.db'),
            KOBO_WORKSPACE_ID: 'a',
            KOBO_MCP_SESSION_TOKEN: capability.token,
            KOBO_BACKEND_URL: `http://127.0.0.1:${address.port}`,
            KOBO_FINAL_REVIEW_TOKEN: 'bound-token',
            KOBO_FINAL_REVIEW_SESSION_ID: 'review-session',
          },
        }),
      )
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toContain('submit_final_review')
      expect(tools.map((t) => t.name)).toContain('list_tasks')
      for (const mutation of [
        'mark_task_done',
        'set_auto_loop',
        'create_workspace',
        'archive_workspace',
        'purge_workspace_worktree',
        'delete_workspace',
        'restore_workspace',
        'unarchive_workspace',
        'send_workspace_message',
        'remember',
        'submit_session_handoff',
      ]) {
        expect(tools.map((t) => t.name)).not.toContain(mutation)
        expect((await client.callTool({ name: mutation, arguments: {} })).isError).toBe(true)
      }
      const report = { summary: 'All clear', findings: [], token: 'caller-spoof', sessionId: 'wrong-session' }
      expect((await client.callTool({ name: 'submit_final_review', arguments: report })).isError).not.toBe(true)
      expect(reportRecord.current).toEqual({
        workspace: 'a',
        body: { token: 'bound-token', sessionId: 'review-session', report },
      })
    } finally {
      await client.close()
      await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())))
    }
  },
  STDIO_TEST_TIMEOUT_MS,
)

it.each(['http', 'stdio-global', 'stdio-workspace'] as const)(
  'sends large inline attachments through %s with the shared schema',
  async (mode) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
    if (!server.listening) await once(server, 'listening')
    const address = server.address() as { port: number }
    const client = new Client({ name: 'attachments-test', version: '1' })
    const url = `http://127.0.0.1:${address.port}`
    try {
      await client.connect(
        mode === 'http'
          ? new StreamableHTTPClientTransport(new URL(`${url}/api/mcp`), {
              requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } },
            })
          : new StdioClientTransport({
              command: process.execPath,
              args: ['--import', 'tsx', 'src/mcp-server/kobo-tasks-server.ts'],
              env: {
                ...process.env,
                KOBO_HOME: directory,
                KOBO_WORKSPACE_ID: mode === 'stdio-workspace' ? 'a' : '',
                KOBO_DB_PATH: getDb().name,
                KOBO_BACKEND_URL: url,
                KOBO_MCP_TOKEN: mcpToken,
                KOBO_MCP_SESSION_TOKEN: managedToken,
              },
              stderr: 'pipe',
            }),
      )
      const { tools } = await client.listTools()
      const messageSchema = tools.find((tool) => tool.name === 'send_workspace_message')!.inputSchema
      const creationSchema = tools.find((tool) => tool.name === 'create_workspace')!.inputSchema
      expect(messageSchema.properties!.attachments).toEqual(creationSchema.properties!.attachments)
      const file = {
        name: 'large.txt',
        mime_type: 'text/plain',
        data_base64: Buffer.alloc(4 * 1024 * 1024, 65).toString('base64'),
      }
      const result = await client.callTool({
        name: 'send_workspace_message',
        arguments: { workspace_id: 'b', attachments: [file] },
      })
      expect(result.isError).not.toBe(true)
      expect(deliverWorkspaceMessage).toHaveBeenCalledWith(
        'b',
        expect.objectContaining({ content: '', attachments: [file] }),
      )
      if (mode === 'stdio-workspace') {
        const own = await client.callTool({
          name: 'send_workspace_message',
          arguments: { workspace_id: 'a', attachments: [file] },
        })
        expect(own.isError).toBe(true)
        expect(deliverWorkspaceMessage).toHaveBeenCalledTimes(1)
      }
    } finally {
      await client.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  },
  STDIO_TEST_TIMEOUT_MS,
)

it('enforces a dedicated workspace-scoped key against real persisted workspaces and memory', async () => {
  const issued = createExternalMcpCredential({ name: 'workspace a only', workspaceIds: ['a'] })
  const client = new Client({ name: 'scoped', version: '1' })
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/api/mcp'), {
    fetch: async (input, init) => app.fetch(new Request(input, init)),
    requestInit: { headers: { Authorization: `Bearer ${issued.token}` } },
  })
  getDb()
    .prepare(
      "INSERT INTO memory_scopes(id,level,workspace_id,created_at,updated_at) VALUES ('secret-scope','workspace','b',datetime('now'),datetime('now'))",
    )
    .run()
  try {
    await client.connect(transport)
    const list = await client.callTool({ name: 'list_workspaces', arguments: {} })
    expect(JSON.parse((list.content as { text: string }[])[0].text)).toEqual([expect.objectContaining({ id: 'a' })])
    const allowed = await client.callTool({ name: 'get_workspace', arguments: { workspace_id: 'a' } })
    expect(allowed.isError).not.toBe(true)
    const denied = await client.callTool({ name: 'get_workspace', arguments: { workspace_id: 'b' } })
    const absent = await client.callTool({ name: 'get_workspace', arguments: { workspace_id: 'does-not-exist' } })
    expect(denied.isError).toBe(true)
    expect(denied).toEqual(absent)
    const memory = await client.callTool({
      name: 'read_memory',
      arguments: { scope_id: 'secret-scope', entry_id: 'anything' },
    })
    expect(memory.isError).toBe(true)
    const mutation = await client.callTool({
      name: 'send_workspace_message',
      arguments: { workspace_id: 'a', content: 'write' },
    })
    expect(mutation.isError).toBe(true)
    expect(deliverWorkspaceMessage).not.toHaveBeenCalled()
  } finally {
    await client.close()
  }
})
