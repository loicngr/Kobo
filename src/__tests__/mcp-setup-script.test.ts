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
import { stopAgentAndWait } from '../server/services/agent/orchestrator.js'
import { createExternalMcpCredential } from '../server/services/external-mcp-credentials-service.js'
import {
  createInternalMcpCapability,
  revokeInternalMcpCapability,
} from '../server/services/internal-mcp-capability-service.js'
import { _setSettingsPath } from '../server/services/settings-service.js'
import { getSetupScriptStatus, runSetupScript } from '../server/services/setup-script-service.js'
import { runScript } from '../server/utils/script-runner.js'

const configuration = vi.hoisted(() => ({ script: 'echo configured-setup' }))
vi.mock('../server/services/settings-service.js', async (original) => {
  const actual = await original<typeof import('../server/services/settings-service.js')>()
  return {
    ...actual,
    getEffectiveSettings: (path: string) => ({
      ...actual.getEffectiveSettings(path),
      setupScript: configuration.script,
    }),
  }
})
vi.mock('../server/services/agent/orchestrator.js', async (original) => ({
  ...(await original<typeof import('../server/services/agent/orchestrator.js')>()),
  stopAgentAndWait: vi.fn(async () => 'stopped'),
}))
vi.mock('../server/utils/script-runner.js', () => ({ SCRIPT_TIMEOUT_MS: 300_000, runScript: vi.fn() }))
vi.mock('../server/services/setup-script-service.js', async (original) => {
  const actual = await original<typeof import('../server/services/setup-script-service.js')>()
  return { ...actual, runSetupScript: vi.fn(actual.runSetupScript) }
})

const app = new Hono().route('/api/mcp', mcp).route('/api/internal-mcp', internalMcp)
let directory: string
let previousHome: string | undefined
beforeEach(() => {
  closeDb()
  directory = mkdtempSync(join(tmpdir(), 'kobo-mcp-setup-'))
  previousHome = process.env.KOBO_HOME
  process.env.KOBO_HOME = directory
  _setSettingsPath(join(directory, 'settings.json'))
  runMigrations(getDb(join(directory, 'test.db')))
  getDb()
    .prepare(
      "INSERT INTO workspaces(id,name,project_path,worktree_path,source_branch,working_branch,created_at,updated_at) VALUES ('own','Own',?,?,'main','feature/setup',datetime('now'),datetime('now'))",
    )
    .run(directory, directory)
  configuration.script = 'echo configured-setup'
  vi.mocked(stopAgentAndWait).mockReset().mockResolvedValue('stopped')
  vi.mocked(runSetupScript).mockClear()
  vi.mocked(runScript).mockReset().mockResolvedValue({ exitCode: 0 })
})
afterEach(() => {
  closeDb()
  if (previousHome === undefined) delete process.env.KOBO_HOME
  else process.env.KOBO_HOME = previousHome
  rmSync(directory, { recursive: true, force: true })
})
function credential(tools = ['run_setup_script']) {
  return createExternalMcpCredential({ name: 'Setup test', workspaceIds: ['own'], tools })
}
async function httpClient(tools?: string[]) {
  const key = credential(tools)
  const client = new Client({ name: 'setup-test', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://localhost/api/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${key.token}` } },
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    }),
  )
  return client
}

it('runs the configured script through the UI route after stopping the agent', async () => {
  const client = await httpClient()
  try {
    expect((await client.listTools()).tools.some((tool) => tool.name === 'run_setup_script')).toBe(true)
    const result = await client.callTool({ name: 'run_setup_script', arguments: { workspace_id: 'own' } })
    expect(result.structuredContent).toEqual({ success: true })
    expect(stopAgentAndWait).toHaveBeenCalledWith('own', undefined, 'setup')
    expect(runSetupScript).toHaveBeenCalledWith(
      'own',
      directory,
      configuration.script,
      {
        workspaceName: 'Own',
        branchName: 'feature/setup',
        sourceBranch: 'main',
        projectPath: directory,
      },
      undefined,
      expect.any(Function),
    )
    expect(vi.mocked(stopAgentAndWait).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runScript).mock.invocationCallOrder[0]!,
    )
    for (const args of [
      {},
      { workspace_id: 'other' },
      { workspace_id: '../own' },
      { workspace_id: 'own', script: 'injected' },
    ]) {
      expect((await client.callTool({ name: 'run_setup_script', arguments: args })).isError).toBe(true)
    }
    expect(runSetupScript).toHaveBeenCalledTimes(1)
  } finally {
    await client.close()
  }
})

it('requires an explicit setup tool grant', async () => {
  const client = await httpClient(['list_workspaces'])
  try {
    expect((await client.listTools()).tools.some((tool) => tool.name === 'run_setup_script')).toBe(false)
    expect((await client.callTool({ name: 'run_setup_script', arguments: { workspace_id: 'own' } })).isError).toBe(true)
    expect(stopAgentAndWait).not.toHaveBeenCalled()
  } finally {
    await client.close()
  }
})

it.each(['missing-script', 'failed-script', 'stop-timeout'] as const)(
  'propagates %s without reporting success',
  async (failure) => {
    if (failure === 'missing-script') configuration.script = ''
    if (failure === 'failed-script') vi.mocked(runScript).mockResolvedValueOnce({ exitCode: 7 })
    if (failure === 'stop-timeout') vi.mocked(stopAgentAndWait).mockResolvedValueOnce('timeout')
    const client = await httpClient()
    try {
      const result = await client.callTool({ name: 'run_setup_script', arguments: { workspace_id: 'own' } })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({ stage: 'setup' })
      expect(result.structuredContent).toMatchObject({
        error: expect.stringContaining(
          failure === 'missing-script'
            ? 'No setup script configured'
            : failure === 'failed-script'
              ? 'exit code 7'
              : 'Agent stop is not confirmed',
        ),
      })
      if (failure !== 'failed-script') expect(runScript).not.toHaveBeenCalled()
      if (failure === 'missing-script') expect(stopAgentAndWait).not.toHaveBeenCalled()
    } finally {
      await client.close()
    }
  },
)

it.each(['archived', 'purged', 'missing-worktree'] as const)(
  'refuses %s before stopping the agent and permits a later valid setup',
  async (state) => {
    if (state === 'archived') getDb().prepare("UPDATE workspaces SET archived_at=datetime('now') WHERE id='own'").run()
    if (state === 'purged')
      getDb().prepare("UPDATE workspaces SET worktree_purged_at=datetime('now') WHERE id='own'").run()
    if (state === 'missing-worktree')
      getDb().prepare("UPDATE workspaces SET worktree_path=? WHERE id='own'").run(join(directory, 'missing'))
    const client = await httpClient()
    try {
      const result = await client.callTool({ name: 'run_setup_script', arguments: { workspace_id: 'own' } })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({ status: state === 'missing-worktree' ? 400 : 409 })
      expect(stopAgentAndWait).not.toHaveBeenCalled()
      expect(runSetupScript).not.toHaveBeenCalled()
      getDb()
        .prepare("UPDATE workspaces SET archived_at=NULL,worktree_purged_at=NULL,worktree_path=? WHERE id='own'")
        .run(directory)
      expect(
        (await client.callTool({ name: 'run_setup_script', arguments: { workspace_id: 'own' } })).structuredContent,
      ).toEqual({ success: true })
      expect(runSetupScript).toHaveBeenCalledOnce()
    } finally {
      await client.close()
    }
  },
)

it('rejects concurrent runs instead of executing setup twice', async () => {
  let finish!: (value: { exitCode: number }) => void
  vi.mocked(runScript).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const client = await httpClient()
  try {
    const first = client.callTool({ name: 'run_setup_script', arguments: { workspace_id: 'own' } })
    await vi.waitFor(() => expect(runScript).toHaveBeenCalledOnce())
    const second = await client.callTool({ name: 'run_setup_script', arguments: { workspace_id: 'own' } })
    finish({ exitCode: 0 })
    expect((await first).isError).not.toBe(true)
    expect(second.isError).toBe(true)
    expect(second.structuredContent).toMatchObject({ status: 409 })
    expect(runSetupScript).toHaveBeenCalledOnce()
  } finally {
    await client.close()
  }
})

it.each(['external', 'internal', 'read-only'] as const)(
  'supports %s stdio with workspace binding and permissions',
  async (mode) => {
    const cap = createInternalMcpCapability({
      workspaceId: 'own',
      sessionId: 'source',
      readOnly: mode === 'read-only',
      restricted: mode === 'read-only',
    })
    const key = credential()
    const listener = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
    if (!listener.listening) await new Promise<void>((resolve) => listener.once('listening', resolve))
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('Missing listener')
    const client = new Client({ name: 'setup-stdio-test', version: '1' })
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
      expect((await client.listTools()).tools.some((tool) => tool.name === 'run_setup_script')).toBe(
        mode !== 'read-only',
      )
      if (mode === 'internal') {
        expect(
          (await client.callTool({ name: 'run_setup_script', arguments: { workspace_id: 'other' } })).isError,
        ).toBe(true)
        vi.mocked(stopAgentAndWait).mockImplementationOnce(async () => {
          revokeInternalMcpCapability(cap.token)
          return 'stopped'
        })
      }
      const result = await client.callTool({
        name: 'run_setup_script',
        arguments: mode === 'external' ? { workspace_id: 'own' } : {},
      })
      expect(result.isError === true).toBe(mode === 'read-only')
      expect(runSetupScript).toHaveBeenCalledTimes(mode === 'read-only' ? 0 : 1)
      if (mode === 'internal')
        expect((await client.callTool({ name: 'run_setup_script', arguments: {} })).isError).toBe(true)
    } finally {
      revokeInternalMcpCapability(cap.token)
      await client.close()
      if ('closeAllConnections' in listener) listener.closeAllConnections()
      await new Promise<void>((resolve) => listener.close(() => resolve()))
    }
  },
  20_000,
)

it.each(['stopped', 'timeout'] as const)('tracks preparation and %s after a previous success', async (outcome) => {
  await runSetupScript('own', directory, configuration.script)
  const previous = getSetupScriptStatus('own')
  let stop!: (value: 'stopped' | 'timeout') => void
  vi.mocked(stopAgentAndWait).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        stop = resolve
      }),
  )
  const client = await httpClient()
  try {
    const pending = client.callTool({ name: 'run_setup_script', arguments: { workspace_id: 'own' } })
    await vi.waitFor(() => expect(stopAgentAndWait).toHaveBeenCalled())
    const preparing = getSetupScriptStatus('own')
    expect(preparing.status).toBe('preparing')
    expect(preparing.runId).not.toBe(previous.runId)
    stop(outcome)
    const response = await pending
    expect(response.isError === true).toBe(outcome === 'timeout')
    expect(getSetupScriptStatus('own')).toMatchObject({
      runId: preparing.runId,
      status: outcome === 'timeout' ? 'failed' : 'succeeded',
    })
    if (outcome === 'timeout') {
      expect(getSetupScriptStatus('own')).toMatchObject({
        exitCode: null,
        error: expect.stringContaining('Agent stop is not confirmed'),
      })
      expect(runScript).toHaveBeenCalledTimes(1)
    }
  } finally {
    await client.close()
  }
})
