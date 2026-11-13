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
  revokeExternalMcpCredential,
} from '../server/services/external-mcp-credentials-service.js'
import {
  createInternalMcpCapability,
  revokeInternalMcpCapability,
} from '../server/services/internal-mcp-capability-service.js'
import { ReviewRequestError, startWorkspaceReview } from '../server/services/review-service.js'

vi.mock('../server/services/review-service.js', async (original) => ({
  ...(await original<typeof import('../server/services/review-service.js')>()),
  startWorkspaceReview: vi.fn(async () => ({ ok: true, sessionId: 'review-session' })),
}))

const app = new Hono().route('/api/mcp', mcp).route('/api/internal-mcp', internalMcp)
let directory: string
let previousHome: string | undefined
beforeEach(() => {
  closeDb()
  directory = mkdtempSync(join(tmpdir(), 'kobo-mcp-review-'))
  previousHome = process.env.KOBO_HOME
  process.env.KOBO_HOME = directory
  runMigrations(getDb(join(directory, 'test.db')))
  vi.mocked(startWorkspaceReview).mockClear()
})
afterEach(() => {
  closeDb()
  if (previousHome === undefined) delete process.env.KOBO_HOME
  else process.env.KOBO_HOME = previousHome
  rmSync(directory, { recursive: true, force: true })
})

const options = {
  engine: 'codex',
  model: 'gpt-5.4',
  reasoning_effort: 'high',
  agent_permission_mode: 'plan',
  additional_instructions: 'Review security.\nDo not fix.',
  new_session: true,
  return_to_session: true,
}
const expected = {
  engine: 'codex',
  model: 'gpt-5.4',
  reasoningEffort: 'high',
  agentPermissionMode: 'plan',
  additionalInstructions: 'Review security.\nDo not fix.',
  newSession: true,
  returnToSession: true,
}
function credential(tools = ['start_code_review']) {
  return createExternalMcpCredential({ name: 'Review test', workspaceIds: ['own'], tools })
}
async function httpClient(token: string) {
  const client = new Client({ name: 'review-test', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://localhost/api/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    }),
  )
  return client
}

it('exposes all dialog options over HTTP and preserves scoped grants and revocation', async () => {
  const key = credential()
  const client = await httpClient(key.token)
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('start_code_review')
    const result = await client.callTool({ name: 'start_code_review', arguments: { workspace_id: 'own', ...options } })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({ sessionId: 'review-session' })
    expect(startWorkspaceReview).toHaveBeenCalledWith('own', expected)
    expect((await client.callTool({ name: 'start_code_review', arguments: { workspace_id: 'other' } })).isError).toBe(
      true,
    )
    expect(startWorkspaceReview).toHaveBeenCalledTimes(1)
    revokeExternalMcpCredential(key.credential.id)
    await expect(client.callTool({ name: 'start_code_review', arguments: { workspace_id: 'own' } })).rejects.toThrow()
    expect(startWorkspaceReview).toHaveBeenCalledTimes(1)
  } finally {
    await client.close()
  }
})

it('requires an explicit tool grant', async () => {
  const client = await httpClient(credential(['list_workspaces']).token)
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain('start_code_review')
    expect((await client.callTool({ name: 'start_code_review', arguments: { workspace_id: 'own' } })).isError).toBe(
      true,
    )
    expect(startWorkspaceReview).not.toHaveBeenCalled()
  } finally {
    await client.close()
  }
})

it('uses a new session by default, allows UI session reuse, and reports launch conflicts', async () => {
  const client = await httpClient(credential().token)
  try {
    await client.callTool({ name: 'start_code_review', arguments: { workspace_id: 'own' } })
    expect(startWorkspaceReview).toHaveBeenLastCalledWith('own', { newSession: true })
    await client.callTool({ name: 'start_code_review', arguments: { workspace_id: 'own', new_session: false } })
    expect(startWorkspaceReview).toHaveBeenLastCalledWith('own', { newSession: false })
    vi.mocked(startWorkspaceReview).mockRejectedValueOnce(
      new ReviewRequestError('A review is already in progress', 409),
    )
    const result = await client.callTool({ name: 'start_code_review', arguments: { workspace_id: 'own' } })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ status: 409, error: 'A review is already in progress' })
  } finally {
    await client.close()
  }
})

it.each([
  {},
  { workspace_id: '../other' },
  { workspace_id: 'own', new_session: 'yes' },
  { workspace_id: 'own', engine: 'unknown' },
  { workspace_id: 'own', model: '' },
  { workspace_id: 'own', additional_instructions: 'x'.repeat(20_001) },
  { workspace_id: 'own', internal: { autoLoopFinalReview: true } },
])('rejects invalid input before launch (case %#)', async (args) => {
  const key = createExternalMcpCredential({ name: 'All', allWorkspaces: true, tools: ['start_code_review'] })
  const client = await httpClient(key.token)
  try {
    expect((await client.callTool({ name: 'start_code_review', arguments: args })).isError).toBe(true)
    expect(startWorkspaceReview).not.toHaveBeenCalled()
  } finally {
    await client.close()
  }
})

it.each(['external', 'internal', 'read-only'] as const)(
  'supports real %s stdio with the same options',
  async (mode) => {
    const key = credential()
    const cap = createInternalMcpCapability({
      workspaceId: 'own',
      sessionId: 'source',
      readOnly: mode === 'read-only',
      restricted: mode === 'read-only',
    })
    const listener = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
    if (!listener.listening) await new Promise<void>((resolve) => listener.once('listening', resolve))
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('Missing listener')
    const client = new Client({ name: 'stdio-review-test', version: '1' })
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
      expect(names.includes('start_code_review')).toBe(mode !== 'read-only')
      const result = await client.callTool({
        name: 'start_code_review',
        arguments: { ...options, ...(mode === 'external' ? { workspace_id: 'own' } : {}) },
      })
      expect(result.isError === true).toBe(mode === 'read-only')
      if (mode === 'read-only') expect(startWorkspaceReview).not.toHaveBeenCalled()
      else expect(startWorkspaceReview).toHaveBeenCalledWith('own', expected)
      if (mode !== 'external') {
        expect(
          (await client.callTool({ name: 'start_code_review', arguments: { workspace_id: 'other' } })).isError,
        ).toBe(true)
        revokeInternalMcpCapability(cap.token)
        expect((await client.callTool({ name: 'start_code_review', arguments: {} })).isError).toBe(true)
        expect(startWorkspaceReview).toHaveBeenCalledTimes(mode === 'read-only' ? 0 : 1)
      }
    } finally {
      revokeInternalMcpCapability(cap.token)
      await client.close()
      if ('closeAllConnections' in listener) listener.closeAllConnections()
      await new Promise<void>((resolve) => listener.close(() => resolve()))
    }
  },
  20_000,
)
