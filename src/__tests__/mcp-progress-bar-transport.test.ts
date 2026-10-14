import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Hono } from 'hono'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { closeDb, getDb } from '../server/db/index.js'
import { runMigrations } from '../server/db/migrations.js'
import internalMcp from '../server/routes/internal-mcp.js'
import mcp from '../server/routes/mcp.js'
import progress from '../server/routes/progress-bars.js'
import {
  createExternalMcpCredential,
  EXTERNAL_TOOL_CATALOGUE,
} from '../server/services/external-mcp-credentials-service.js'
import { createInternalMcpCapability } from '../server/services/internal-mcp-capability-service.js'
import {
  closeProgressCapability,
  createProgressCapability,
  revokeProgressCapability,
} from '../server/services/progress-bar-runtime.js'

const app = new Hono()
  .route('/api/mcp', mcp)
  .route('/api/internal-mcp', internalMcp)
  .route('/api/progress-bars', progress)
let externalToken: string
let previousHome: string | undefined
let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'kobo-progress-'))
  previousHome = process.env.KOBO_HOME
  process.env.KOBO_HOME = directory
  externalToken = createExternalMcpCredential({
    name: 'Transport test',
    allWorkspaces: true,
    tools: EXTERNAL_TOOL_CATALOGUE.map((tool) => tool.name),
  }).token
  closeDb()
  runMigrations(getDb(join(directory, 'test.db')))
  getDb()
    .prepare(
      "INSERT INTO workspaces(id,name,project_path,source_branch,working_branch,created_at,updated_at) VALUES ('w','Workspace','/tmp','main','feature','now','now')",
    )
    .run()
  getDb().prepare("INSERT INTO agent_sessions(id,workspace_id,started_at) VALUES ('s','w','now')").run()
})
afterEach(() => {
  process.env.KOBO_HOME = previousHome
  closeDb()
  rmSync(directory, { recursive: true, force: true })
})
function data(result: Awaited<ReturnType<Client['callTool']>>) {
  return JSON.parse((result.content as Array<{ text: string }>)[0].text)
}
async function exercise(client: Client, external: boolean) {
  const tools = (await client.listTools()).tools
  expect(tools.filter((t) => t.name.endsWith('progress_bar') || t.name === 'list_progress_bars')).toHaveLength(4)
  expect(tools.find((t) => t.name === 'create_progress_bar')?.annotations?.readOnlyHint).toBe(false)
  expect(tools.find((t) => t.name === 'update_progress_bar')?.description).toContain(
    'Omit both numbers for step-only updates',
  )
  const scope = external ? { workspace_id: 'w', session_id: 's' } : {}
  const created = await client.callTool({
    name: 'create_progress_bar',
    arguments: { ...scope, activity_key: 'test', label: 'Tests' },
  })
  expect(created.isError).not.toBe(true)
  const bar = data(created)
  expect(bar).toMatchObject({ workspaceId: 'w', sessionId: 's', label: 'Tests' })
  const updated = await client.callTool({
    name: 'update_progress_bar',
    arguments: { ...scope, progress_id: bar.id, sequence: 1, current: 1, total: 2 },
  })
  expect(data(updated)).toMatchObject({ current: 1, total: 2 })
  const limited = await client.callTool({
    name: 'update_progress_bar',
    arguments: { ...scope, progress_id: bar.id, sequence: 2, current: 2, total: 2 },
  })
  expect(limited.isError).toBe(true)
  expect(data(limited)).toMatchObject({ status: 429, retryAfterMs: expect.any(Number) })
  expect(
    data(
      await client.callTool({
        name: 'finish_progress_bar',
        arguments: { ...scope, progress_id: bar.id, sequence: 3, outcome: 'succeeded' },
      }),
    ),
  ).toMatchObject({ status: 'succeeded' })
  expect(data(await client.callTool({ name: 'list_progress_bars', arguments: scope })).items).toHaveLength(1)
  // An audit can advance through real phases without a known denominator.
  const audit = data(
    await client.callTool({
      name: 'create_progress_bar',
      arguments: { ...scope, activity_key: 'audit', label: 'Audit', step: 'Read code' },
    }),
  )
  expect(audit).toMatchObject({ current: null, total: null, sequence: 0, status: 'running' })
  const step = data(
    await client.callTool({
      name: 'update_progress_bar',
      arguments: { ...scope, progress_id: audit.id, sequence: audit.sequence + 1, step: 'Verify findings' },
    }),
  )
  expect(step).toMatchObject({ id: audit.id, step: 'Verify findings', current: null, total: null, sequence: 1 })
  expect(step.revision).toBeGreaterThan(audit.revision)
  const finished = data(
    await client.callTool({
      name: 'finish_progress_bar',
      arguments: {
        ...scope,
        progress_id: audit.id,
        sequence: step.sequence + 1,
        outcome: 'succeeded',
        step: 'Audit complete',
      },
    }),
  )
  expect(finished).toMatchObject({ id: audit.id, status: 'succeeded', sequence: 2, current: null, total: null })
  const hydrated = await app.request('/api/progress-bars?workspaceId=w&sessionId=s')
  expect((await hydrated.json()).items).toContainEqual(finished)
  expect(getDb().prepare('SELECT count(*) n FROM session_progress_bars').get()).toEqual({ n: 2 })
  const invalid = await client.callTool({ name: 'list_progress_bars', arguments: { ...scope, unexpected: true } })
  expect(invalid.isError).toBe(true)
  expect(data(invalid)).toMatchObject({ status: 400, code: 'invalid_arguments' })
}
it('exposes external HTTP progress with structured errors', async () => {
  const client = new Client({ name: 'progress-http', version: '1' })
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://localhost/api/mcp'), {
        requestInit: { headers: { Authorization: `Bearer ${externalToken}` } },
        fetch: async (input, init) => app.fetch(new Request(input, init)),
      }),
    )
    await exercise(client, true)
  } finally {
    await client.close()
  }
})
it.each(['global', 'workspace', 'review', 'handoff', 'unscoped'])(
  'supports %s stdio without widening capabilities',
  async (mode) => {
    const listener = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
    if (!listener.listening) await new Promise<void>((r) => listener.once('listening', r))
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('No address')
    const cap = createProgressCapability('w', 's')
    const managed = createInternalMcpCapability({
      workspaceId: 'w',
      sessionId: 's',
      readOnly: mode === 'review' || mode === 'handoff',
      env: {
        ...(mode !== 'unscoped' ? { KOBO_PROGRESS_SESSION_TOKEN: cap.token } : {}),
        ...(mode === 'review' ? { KOBO_FINAL_REVIEW_TOKEN: 'review', KOBO_FINAL_REVIEW_SESSION_ID: 's' } : {}),
        ...(mode === 'handoff' ? { KOBO_HANDOFF_ID: 'handoff', KOBO_HANDOFF_TOKEN: 'handoff' } : {}),
      },
    })
    const client = new Client({ name: 'progress-stdio', version: '1' })
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ['--import', 'tsx', 'src/mcp-server/kobo-tasks-server.ts'],
          env: {
            PATH: process.env.PATH ?? '',
            KOBO_HOME: directory,
            KOBO_MCP_TOKEN: externalToken,
            KOBO_MCP_SESSION_TOKEN: managed.token,
            KOBO_DB_PATH: getDb().name,
            KOBO_WORKSPACE_ID: mode === 'global' ? '' : 'w',
            KOBO_BACKEND_URL: `http://127.0.0.1:${address.port}`,
            ...(mode !== 'unscoped' ? { KOBO_PROGRESS_SESSION_TOKEN: cap.token } : {}),
            ...(mode === 'review' ? { KOBO_FINAL_REVIEW_TOKEN: 'review', KOBO_FINAL_REVIEW_SESSION_ID: 's' } : {}),
            ...(mode === 'handoff' ? { KOBO_HANDOFF_ID: 'handoff', KOBO_HANDOFF_TOKEN: 'handoff' } : {}),
          },
          stderr: 'pipe',
        }),
      )
      if (mode === 'unscoped') {
        expect(
          (
            await client.callTool({
              name: 'create_progress_bar',
              arguments: { workspace_id: 'w', session_id: 's', activity_key: 'evil', label: 'No' },
            })
          ).isError,
        ).toBe(true)
        expect(getDb().prepare('SELECT count(*) n FROM session_progress_bars').get()).toEqual({ n: 0 })
      } else {
        await exercise(client, mode === 'global')
      }
      if (mode !== 'global' && mode !== 'unscoped') {
        revokeProgressCapability(cap.token)
        expect((await client.callTool({ name: 'list_progress_bars', arguments: {} })).isError).toBe(true)
      }
      if (mode === 'review' || mode === 'handoff')
        expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('mark_task_done')
    } finally {
      await client.close()
      closeProgressCapability(cap)
      await new Promise<void>((resolve, reject) => listener.close((e) => (e ? reject(e) : resolve())))
    }
  },
  15000,
)
