import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Hono } from 'hono'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { closeDb, getDb } from '../server/db/index.js'
import { runMigrations } from '../server/db/migrations.js'
import internalMcp from '../server/routes/internal-mcp.js'
import {
  createInternalMcpCapability,
  revokeInternalMcpCapability,
} from '../server/services/internal-mcp-capability-service.js'
import { createProgressCapability } from '../server/services/progress-bar-runtime.js'
import { createIdleSession } from '../server/services/workspace-service.js'

let directory: string
const app = new Hono().route('/api/internal-mcp', internalMcp)
beforeEach(() => {
  closeDb()
  directory = mkdtempSync(join(tmpdir(), 'kobo-managed-security-'))
  runMigrations(getDb(join(directory, 'test.db')))
  getDb()
    .prepare(
      "INSERT INTO workspaces(id,name,project_path,source_branch,working_branch,created_at,updated_at) VALUES ('own','own','/tmp','main','feature',datetime('now'),datetime('now'))",
    )
    .run()
})
afterEach(() => {
  closeDb()
  rmSync(directory, { recursive: true, force: true })
})

it.each([true, false])(
  'enforces backend permissions and revocation through real stdio (readOnly=%s)',
  async (readOnly) => {
    const session = createIdleSession('own')
    const progress = createProgressCapability('own', session.id)
    const cap = createInternalMcpCapability({
      workspaceId: 'own',
      sessionId: session.id,
      readOnly,
      env: { KOBO_PROGRESS_SESSION_TOKEN: progress.token },
    })
    const listener = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
    if (!listener.listening) await new Promise<void>((resolve) => listener.once('listening', resolve))
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('Missing listener')
    const client = new Client({ name: 'managed-security-test', version: '1' })
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ['--import', 'tsx', 'src/mcp-server/kobo-tasks-server.ts'],
          env: {
            PATH: process.env.PATH ?? '',
            KOBO_WORKSPACE_ID: 'own',
            KOBO_MCP_SESSION_TOKEN: cap.token,
            KOBO_BACKEND_URL: `http://127.0.0.1:${address.port}`,
          },
          stderr: 'pipe',
        }),
      )
      const names = (await client.listTools()).tools.map((tool) => tool.name)
      expect(names.includes('create_task')).toBe(!readOnly)
      expect(names).toContain('list_tasks')
      const created = await client.callTool({
        name: 'create_task',
        arguments: { title: 'Synthetic permission regression' },
      })
      expect(created.isError === true).toBe(readOnly)
      expect(getDb().prepare('SELECT count(*) n FROM tasks').get()).toEqual({ n: readOnly ? 0 : 1 })
      const bar = await client.callTool({
        name: 'create_progress_bar',
        arguments: { activity_key: 'audit', label: 'Synthetic check' },
      })
      expect(bar.isError).not.toBe(true)
      revokeInternalMcpCapability(cap.token)
      expect((await client.callTool({ name: 'create_task', arguments: { title: 'After stop' } })).isError).toBe(true)
      expect((await client.callTool({ name: 'list_tasks', arguments: {} })).isError).toBe(true)
      expect(
        (
          await client.callTool({
            name: 'create_progress_bar',
            arguments: { activity_key: 'late', label: 'After stop' },
          })
        ).isError,
      ).toBe(true)
      expect(getDb().prepare('SELECT count(*) n FROM tasks').get()).toEqual({ n: readOnly ? 0 : 1 })
      expect(getDb().prepare('SELECT count(*) n FROM session_progress_bars').get()).toEqual({ n: 1 })
    } finally {
      revokeInternalMcpCapability(cap.token)
      await client.close()
      await new Promise<void>((resolve) => listener.close(() => resolve()))
    }
  },
  15000,
)

it('rejects caller supplied flags, targets and missing capabilities', async () => {
  const cap = createInternalMcpCapability({ workspaceId: 'own', sessionId: 'session', readOnly: true })
  const response = await app.request('/api/internal-mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Kobo-Mcp-Session': cap.token },
    body: JSON.stringify({
      method: 'call',
      name: 'create_task',
      arguments: { title: 'No', readOnly: false, workspace_id: 'other' },
    }),
  })
  expect(response.status).toBe(403)
  expect(
    (await app.request('/api/internal-mcp', { method: 'POST', body: JSON.stringify({ method: 'list' }) })).status,
  ).toBe(403)
  revokeInternalMcpCapability(cap.token)
})

it('rechecks launch revocation after receiving a request body', async () => {
  const cap = createInternalMcpCapability({ workspaceId: 'own', sessionId: 'session', readOnly: false })
  let bodyStarted!: () => void
  const reading = new Promise<void>((resolve) => {
    bodyStarted = resolve
  })
  let finishBody!: () => void
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        finishBody = () => {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({ method: 'call', name: 'create_task', arguments: { title: 'Too late' } }),
            ),
          )
          controller.close()
        }
      },
      pull() {
        bodyStarted()
      },
    },
    { highWaterMark: 0 },
  )
  const pending = app.fetch(
    new Request('http://localhost/api/internal-mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kobo-Mcp-Session': cap.token },
      body,
      duplex: 'half',
    } as RequestInit),
  )
  await reading
  revokeInternalMcpCapability(cap.token)
  finishBody()
  expect((await pending).status).toBe(403)
  expect(getDb().prepare('SELECT count(*) n FROM tasks').get()).toEqual({ n: 0 })
})

it('rejects invalid capabilities before consuming a large or slow body', async () => {
  let consumed = false
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        consumed = true
        controller.close()
      },
    },
    { highWaterMark: 0 },
  )
  const response = await app.fetch(
    new Request('http://localhost/api/internal-mcp', {
      method: 'POST',
      headers: { 'X-Kobo-Mcp-Session': 'invalid' },
      body,
      duplex: 'half',
    } as RequestInit),
  )
  expect(response.status).toBe(403)
  expect(consumed).toBe(false)
})

it('treats search query text as data rather than a request path', async () => {
  const cap = createInternalMcpCapability({ workspaceId: 'own', sessionId: 'session', readOnly: true })
  try {
    const response = await app.request('/api/internal-mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kobo-Mcp-Session': cap.token },
      body: JSON.stringify({ method: 'call', name: 'search_codebase', arguments: { query: '../src' } }),
    })
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result.isError).not.toBe(true)
    expect(JSON.parse(result.content[0].text)).toMatchObject({ query: '../src', results: [] })
  } finally {
    revokeInternalMcpCapability(cap.token)
  }
})
