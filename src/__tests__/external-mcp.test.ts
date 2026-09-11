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
import mcp from '../server/routes/mcp.js'
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

let directory: string
const app = new Hono().route('/api/mcp', mcp)
app.post('/api/workspaces/:id/stop', (c) => c.json({ token: c.req.header('X-Kobo-Token') ?? null }))
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(agent.getPendingInputs).mockReturnValue([])
  closeDb()
  directory = mkdtempSync(join(tmpdir(), 'kobo-external-mcp-'))
  const db = getDb(join(directory, 'test.db'))
  runMigrations(db)
  for (const id of ['a', 'b'])
    db.prepare(
      "INSERT INTO workspaces(id,name,project_path,source_branch,working_branch,created_at,updated_at) VALUES (?,?,'/tmp','main','feature',datetime('now'),datetime('now'))",
    ).run(id, id)
})
afterEach(() => {
  closeDb()
  rmSync(directory, { recursive: true, force: true })
})

it('supports initialization, discovery and tool calls through the SDK HTTP client', async () => {
  const client = new Client({ name: 'external-test', version: '1' })
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/api/mcp'), {
    fetch: async (input, init) => app.fetch(new Request(input, init)),
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

it('exposes the dialogue tools through the existing global stdio server', async () => {
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
          KOBO_NETWORK_TOKEN: 'test-token',
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
    expect(JSON.parse((stopped.content as { text: string }[])[0].text)).toMatchObject({ token: 'test-token' })
  } finally {
    await client.close()
    await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())))
  }
})

it('rejects oversized MCP requests before tool dispatch', async () => {
  const response = await app.request('/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
