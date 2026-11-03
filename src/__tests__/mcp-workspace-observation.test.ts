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
import * as orchestrator from '../server/services/agent/orchestrator.js'
import {
  createExternalMcpCredential,
  revokeExternalMcpCredential,
} from '../server/services/external-mcp-credentials-service.js'
import {
  createInternalMcpCapability,
  revokeInternalMcpCapability,
} from '../server/services/internal-mcp-capability-service.js'
import { getMistralOptions } from '../server/services/mistral-options-service.js'
import { _setSettingsPath, updateGlobalSettings } from '../server/services/settings-service.js'
import { getSetupScriptStatus, runSetupScript } from '../server/services/setup-script-service.js'
import { emit } from '../server/services/websocket-service.js'
import { reserveWorkspaceLifecycle } from '../server/utils/workspace-lifecycle-guard.js'
import { WORKSPACE_OBSERVATION_TOOLS } from '../shared/workspace-observation-tools.js'

vi.mock('../server/services/agent/orchestrator.js', async (original) => ({
  ...(await original<typeof import('../server/services/agent/orchestrator.js')>()),
  stopParallelReview: vi.fn(async () => 'stopped' as const),
  retryParallelReviewReturn: vi.fn(),
  cancelParallelReviewReturn: vi.fn(),
  retryReviewReturn: vi.fn(),
  cancelReviewReturn: vi.fn(),
}))
vi.mock('../server/services/mistral-options-service.js', () => ({ getMistralOptions: vi.fn() }))
const app = new Hono().route('/api/mcp', mcp).route('/api/internal-mcp', internalMcp)
const tools = WORKSPACE_OBSERVATION_TOOLS.map((tool) => tool.name)
let directory: string
let oldHome: string | undefined
beforeEach(() => {
  vi.clearAllMocks()
  closeDb()
  directory = mkdtempSync(join(tmpdir(), 'kobo-observation-'))
  oldHome = process.env.KOBO_HOME
  process.env.KOBO_HOME = directory
  _setSettingsPath(join(directory, 'settings.json'))
  runMigrations(getDb(join(directory, 'test.db')))
  for (const id of ['own', 'other'])
    getDb()
      .prepare(
        "INSERT INTO workspaces(id,name,project_path,source_branch,working_branch,created_at,updated_at) VALUES (?,?,?,'main','feature/test',datetime('now'),datetime('now'))",
      )
      .run(id, id, directory)
  for (const id of ['review', 'source'])
    getDb()
      .prepare(
        "INSERT INTO agent_sessions(id,workspace_id,status,started_at) VALUES (?,'own','completed',datetime('now'))",
      )
      .run(id)
  getDb()
    .prepare(
      "INSERT INTO parallel_reviews(workspace_id,review_session_id,original_session_id,original_configuration,return_to_session) VALUES ('own','review','source','{}',1)",
    )
    .run()
  getDb()
    .prepare(
      "INSERT INTO pending_review_returns(workspace_id,review_session_id,original_session_id,original_configuration,review_configuration,created_at) VALUES ('own','review','source','{}','{}',datetime('now'))",
    )
    .run()
})
afterEach(() => {
  closeDb()
  if (oldHome === undefined) delete process.env.KOBO_HOME
  else process.env.KOBO_HOME = oldHome
  rmSync(directory, { recursive: true, force: true })
})
async function connect(grants = tools) {
  const key = createExternalMcpCredential({ name: 'Observation', workspaceIds: ['own'], tools: grants })
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://localhost/api/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${key.token}` } },
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    }),
  )
  return { client, key }
}
it('discovers all tools and reads only the permitted workspace, with live revocation', async () => {
  const { client, key } = await connect()
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(tools)
    const status = await client.callTool({ name: 'get_code_review_status', arguments: { workspace_id: 'own' } })
    expect(status.structuredContent).toMatchObject({
      parallel: { reviewSessionId: 'review' },
      return: { reviewSessionId: 'review' },
    })
    for (const name of tools)
      expect(
        (
          await client.callTool({
            name,
            arguments: { workspace_id: 'other', session_id: 'review', review_type: 'parallel' },
          })
        ).isError,
      ).toBe(true)
    revokeExternalMcpCredential(key.credential.id)
    await expect(client.callTool({ name: tools[0]!, arguments: { workspace_id: 'own' } })).rejects.toThrow()
  } finally {
    await client.close()
  }
})
it('requires explicit grants, including for discovery', async () => {
  const { client } = await connect(['get_code_review_status'])
  try {
    expect((await client.callTool({ name: 'list_agent_options', arguments: { workspace_id: 'own' } })).isError).toBe(
      true,
    )
  } finally {
    await client.close()
  }
})
it('uses existing UI actions for exact review sessions and preserves lifecycle failures', async () => {
  const { client } = await connect()
  try {
    for (const [name, kind, method] of [
      ['stop_code_review', undefined, orchestrator.stopParallelReview],
      ['retry_code_review_return', 'parallel', orchestrator.retryParallelReviewReturn],
      ['cancel_code_review_return', 'parallel', orchestrator.cancelParallelReviewReturn],
      ['retry_code_review_return', 'return', orchestrator.retryReviewReturn],
      ['cancel_code_review_return', 'return', orchestrator.cancelReviewReturn],
    ] as const) {
      const args = { workspace_id: 'own', session_id: 'stale', ...(kind ? { review_type: kind } : {}) }
      expect((await client.callTool({ name, arguments: args })).isError).toBe(true)
      expect(method).not.toHaveBeenCalled()
      expect((await client.callTool({ name, arguments: { ...args, session_id: 'review' } })).isError).not.toBe(true)
      expect(method).toHaveBeenCalledWith(...(kind === 'return' ? ['own'] : ['own', 'review']))
    }
    vi.mocked(orchestrator.stopParallelReview).mockRejectedValueOnce(new Error('Review is closing'))
    const failed = await client.callTool({
      name: 'stop_code_review',
      arguments: { workspace_id: 'own', session_id: 'review' },
    })
    expect(failed.isError).toBe(true)
    expect(failed.structuredContent).toMatchObject({ status: 409, error: 'Review is closing' })
  } finally {
    await client.close()
  }
})
it('exposes model catalogues and contextual native options without settings secrets', async () => {
  updateGlobalSettings({ tags: ['API', 'urgent'], notionMcpKey: 'do-not-expose' })
  const native = {
    model: { currentValue: 'devstral', options: [{ value: 'devstral', name: 'Devstral' }] },
    thinking: { currentValue: 'high', options: [{ value: 'high', name: 'High' }] },
  }
  vi.mocked(getMistralOptions).mockResolvedValue(native)
  const { client } = await connect()
  try {
    const tags = await client.callTool({ name: 'list_workspace_tags', arguments: { workspace_id: 'own' } })
    expect(tags.structuredContent).toEqual({ tags: ['API', 'urgent'], workspaceTags: [] })
    const result = await client.callTool({
      name: 'list_agent_options',
      arguments: { workspace_id: 'own', engine: 'codex' },
    })
    expect(result.structuredContent).toMatchObject({
      engines: [
        { id: 'codex', models: expect.any(Array), effortLevels: expect.any(Array), permissionModes: expect.any(Array) },
      ],
    })
    expect(JSON.stringify(result)).not.toContain('do-not-expose')
    expect(getMistralOptions).not.toHaveBeenCalled()
    const vibe = await client.callTool({
      name: 'list_agent_options',
      arguments: {
        workspace_id: 'own',
        engine: 'mistral-vibe',
        model: 'devstral',
        agent_permission_mode: 'interactive',
      },
    })
    expect(vibe.structuredContent).toMatchObject({ nativeOptions: native })
    expect(getMistralOptions).toHaveBeenCalledWith({
      workspaceId: 'own',
      model: 'devstral',
      agentPermissionMode: 'interactive',
    })
    vi.mocked(getMistralOptions).mockRejectedValueOnce(new Error('Native discovery unavailable'))
    expect(
      (
        await client.callTool({
          name: 'list_agent_options',
          arguments: { workspace_id: 'own', engine: 'mistral-vibe' },
        })
      ).isError,
    ).toBe(true)
  } finally {
    await client.close()
  }
})
it('rejects unknown fields and malformed selectors before actions', async () => {
  const { client } = await connect()
  try {
    for (const [name, args] of [
      ['get_setup_script_status', { limit: 101 }],
      ['get_setup_script_status', { limit: 1.5 }],
      ['get_setup_script_status', { after_id: 'cursor' }],
      ['get_setup_script_status', { run_id: '../x' }],
      ['stop_code_review', {}],
      ['stop_code_review', { session_id: 'review', command: 'shell' }],
      ['retry_code_review_return', { session_id: 'review', review_type: 'other' }],
      ['list_agent_options', { model: 'x' }],
      ['list_workspace_tags', { project_path: '/other' }],
    ] as const)
      expect((await client.callTool({ name, arguments: { workspace_id: 'own', ...args } })).isError).toBe(true)
    expect(orchestrator.stopParallelReview).not.toHaveBeenCalled()
  } finally {
    await client.close()
  }
})
it('persists actual setup results, separates runs and bounds paginated logs', async () => {
  const running = runSetupScript('own', directory, 'echo first; echo second; exit 7')
  expect(getSetupScriptStatus('own').status).toBe('running')
  await running
  const first = getSetupScriptStatus('own', undefined, undefined, 1)
  expect(first).toMatchObject({ status: 'failed', exitCode: 7, hasMore: true, logs: [{ text: 'first' }] })
  const second = getSetupScriptStatus('own', first.runId!, first.nextAfterId!, 1)
  expect(second).toMatchObject({ hasMore: false, logs: [{ text: 'second' }] })
  await runSetupScript('own', directory, 'echo new')
  expect(getSetupScriptStatus('own')).toMatchObject({ status: 'succeeded', exitCode: 0, logs: [{ text: 'new' }] })
  expect(getSetupScriptStatus('own', first.runId!)).toMatchObject({
    status: 'failed',
    logs: [{ text: 'first' }, { text: 'second' }],
  })
  expect(() => getSetupScriptStatus('other', first.runId!)).toThrow()
  expect(() => getSetupScriptStatus('own', undefined, first.nextAfterId!)).toThrow()
  closeDb()
  getDb(join(directory, 'test.db'))
  expect(getSetupScriptStatus('own').status).toBe('succeeded')
  emit('own', 'setup:run-started', { runId: 'lost-run' })
  emit('own', 'setup:output', { text: 'x'.repeat(2000) })
  expect(getSetupScriptStatus('own')).toMatchObject({
    status: 'unknown',
    logs: [{ text: 'x'.repeat(1000), truncated: true }],
  })
  const { client } = await connect()
  try {
    expect(
      (await client.callTool({ name: 'get_setup_script_status', arguments: { workspace_id: 'own' } }))
        .structuredContent,
    ).toMatchObject({ status: 'unknown', runId: 'lost-run' })
  } finally {
    await client.close()
  }
})
it.each(['external', 'managed', 'read-only'] as const)(
  'exposes discovery and enforces mutation permissions over %s stdio',
  async (mode) => {
    const key = createExternalMcpCredential({ name: 'stdio', workspaceIds: ['own'], tools })
    const cap = createInternalMcpCapability({ workspaceId: 'own', sessionId: 'source', readOnly: mode === 'read-only' })
    const listener = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
    if (!listener.listening) await once(listener, 'listening')
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('No port')
    const client = new Client({ name: 'stdio-test', version: '1' })
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ['--import', 'tsx', 'src/mcp-server/kobo-tasks-server.ts'],
          env: {
            PATH: process.env.PATH ?? '',
            KOBO_BACKEND_URL: `http://127.0.0.1:${address.port}`,
            ...(mode === 'external'
              ? { KOBO_MCP_TOKEN: key.token }
              : { KOBO_WORKSPACE_ID: 'own', KOBO_MCP_SESSION_TOKEN: cap.token }),
          },
          stderr: 'pipe',
        }),
      )
      const names = (await client.listTools()).tools.map((tool) => tool.name)
      for (const tool of WORKSPACE_OBSERVATION_TOOLS)
        expect(names.includes(tool.name)).toBe(mode !== 'read-only' || tool.annotations?.readOnlyHint === true)
      expect(names.filter((name) => name === 'get_code_review_status')).toHaveLength(1)
      const args = mode === 'external' ? { workspace_id: 'own' } : {}
      expect(
        (await client.callTool({ name: 'get_code_review_status', arguments: args })).structuredContent,
      ).toMatchObject({ parallel: { reviewSessionId: 'review' } })
      expect(
        (await client.callTool({ name: 'stop_code_review', arguments: { ...args, session_id: 'review' } })).isError ===
          true,
      ).toBe(mode === 'read-only')
      expect(
        (await client.callTool({ name: 'list_agent_options', arguments: { workspace_id: 'other' } })).isError,
      ).toBe(true)
      revokeInternalMcpCapability(cap.token)
      if (mode !== 'external')
        expect((await client.callTool({ name: 'get_code_review_status', arguments: {} })).isError).toBe(true)
    } finally {
      revokeInternalMcpCapability(cap.token)
      await client.close()
      if ('closeAllConnections' in listener) listener.closeAllConnections()
      await new Promise<void>((resolve) => listener.close(() => resolve()))
    }
  },
  20_000,
)

it('rechecks the sequential reviewer at the route boundary and preserves calls from the UI', async () => {
  const { default: routes } = await import('../server/routes/workspaces.js')
  for (const action of ['retry', 'cancel']) {
    const stale = await routes.request(`http://kobo.internal/own/review-return/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'stale' }),
    })
    expect(stale.status).toBe(409)
    expect(orchestrator.retryReviewReturn).not.toHaveBeenCalled()
    expect(orchestrator.cancelReviewReturn).not.toHaveBeenCalled()
  }
  expect((await routes.request('http://kobo.internal/own/review-return/retry', { method: 'POST' })).status).toBe(200)
  expect(orchestrator.retryReviewReturn).toHaveBeenCalledWith('own')
  expect(
    (
      await routes.request('http://kobo.internal/own/review-return/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    ).status,
  ).toBe(200)
})

it('preserves the workspace handoff guard for every parallel review action', async () => {
  const { client } = await connect()
  const reservation = reserveWorkspaceLifecycle('own', 'session-handoff')
  try {
    for (const name of ['stop_code_review', 'retry_code_review_return', 'cancel_code_review_return']) {
      const result = await client.callTool({
        name,
        arguments: {
          workspace_id: 'own',
          session_id: 'review',
          ...(name === 'stop_code_review' ? {} : { review_type: 'parallel' }),
        },
      })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({
        status: 409,
        error: expect.stringContaining('session transfer'),
      })
    }
    expect(orchestrator.stopParallelReview).not.toHaveBeenCalled()
    expect(orchestrator.retryParallelReviewReturn).not.toHaveBeenCalled()
    expect(orchestrator.cancelParallelReviewReturn).not.toHaveBeenCalled()
    expect(getDb().prepare("SELECT return_to_session FROM parallel_reviews WHERE workspace_id='own'").get()).toEqual({
      return_to_session: 1,
    })
  } finally {
    reservation.release()
    await client.close()
  }
})
