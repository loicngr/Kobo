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
import * as websocket from '../server/services/websocket-service.js'
import { getWorkspace, setWorkspaceTags } from '../server/services/workspace-service.js'

const emitEphemeral = vi.spyOn(websocket, 'emitEphemeral')
const app = new Hono().route('/api/mcp', mcp).route('/api/internal-mcp', internalMcp)
const tools = ['add_workspace_tags', 'remove_workspace_tags']
let directory: string
let previousHome: string | undefined
beforeEach(() => {
  closeDb()
  directory = mkdtempSync(join(tmpdir(), 'kobo-mcp-tags-'))
  previousHome = process.env.KOBO_HOME
  process.env.KOBO_HOME = directory
  runMigrations(getDb(join(directory, 'test.db')))
  getDb()
    .prepare(
      "INSERT INTO workspaces(id,name,project_path,source_branch,working_branch,created_at,updated_at) VALUES ('own','Own',?,'main','feature/tags',datetime('now'),datetime('now'))",
    )
    .run(directory)
  setWorkspaceTags('own', ['existing'])
  vi.mocked(emitEphemeral).mockClear()
})
afterEach(() => {
  closeDb()
  if (previousHome === undefined) delete process.env.KOBO_HOME
  else process.env.KOBO_HOME = previousHome
  rmSync(directory, { recursive: true, force: true })
})
async function httpClient(grants = tools) {
  const key = createExternalMcpCredential({ name: 'Tags', workspaceIds: ['own'], tools: grants })
  const client = new Client({ name: 'tags-test', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://localhost/api/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${key.token}` } },
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    }),
  )
  return { client, key }
}
it('adds/removes only the requested tags, handles repeats and publishes the saved state', async () => {
  const { client } = await httpClient()
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(tools))
    for (let i = 0; i < 2; i++) {
      const result = await client.callTool({
        name: tools[0]!,
        arguments: { workspace_id: 'own', tags: [' API ', 'API', 'api'] },
      })
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toMatchObject({ tags: ['existing', 'API', 'api'] })
    }
    await Promise.all(
      ['one', 'two'].map((tag) =>
        client.callTool({ name: tools[0]!, arguments: { workspace_id: 'own', tags: [tag] } }),
      ),
    )
    expect(getWorkspace('own')!.tags).toEqual(expect.arrayContaining(['existing', 'API', 'api', 'one', 'two']))
    for (let i = 0; i < 2; i++)
      await client.callTool({ name: tools[1]!, arguments: { workspace_id: 'own', tags: [' API ', 'absent'] } })
    expect(getWorkspace('own')!.tags).toEqual(['existing', 'api', 'one', 'two'])
    expect(emitEphemeral).toHaveBeenLastCalledWith('own', 'workspace:tags-updated', {
      tags: ['existing', 'api', 'one', 'two'],
    })
  } finally {
    await client.close()
  }
})
it('rejects malformed tags and overflow without dropping existing tags', async () => {
  const { client } = await httpClient()
  try {
    for (const tags of [null, 'API', [], [''], ['   '], [42], ['x'.repeat(51)], Array(51).fill('API')]) {
      expect((await client.callTool({ name: tools[0]!, arguments: { workspace_id: 'own', tags } })).isError).toBe(true)
      expect(getWorkspace('own')!.tags).toEqual(['existing'])
    }
    const full = Array.from({ length: 50 }, (_, i) => `tag-${i}`)
    setWorkspaceTags('own', full)
    expect(
      (await client.callTool({ name: tools[0]!, arguments: { workspace_id: 'own', tags: ['overflow'] } })).isError,
    ).toBe(true)
    expect(getWorkspace('own')!.tags).toEqual(full)
    expect(
      (await client.callTool({ name: tools[1]!, arguments: { workspace_id: 'own', tags: full } })).isError,
    ).not.toBe(true)
    expect(getWorkspace('own')!.tags).toEqual([])
  } finally {
    await client.close()
  }
})
it('enforces independent tool grants, workspace scope, unknown fields and revocation', async () => {
  const { client, key } = await httpClient([tools[0]!])
  try {
    for (const [name, args] of [
      [tools[1]!, { workspace_id: 'own', tags: ['existing'] }],
      [tools[0]!, { workspace_id: 'other', tags: ['API'] }],
      [tools[0]!, { workspace_id: 'own', tags: ['API'], operation: 'replace' }],
    ] as const)
      expect((await client.callTool({ name, arguments: args })).isError).toBe(true)
    expect(getWorkspace('own')!.tags).toEqual(['existing'])
    revokeExternalMcpCredential(key.credential.id)
    await expect(
      client.callTool({ name: tools[0]!, arguments: { workspace_id: 'own', tags: ['API'] } }),
    ).rejects.toThrow()
  } finally {
    await client.close()
  }
})
it.each(['external', 'internal', 'read-only'] as const)(
  'supports %s stdio and binds managed calls to their workspace',
  async (mode) => {
    const key = createExternalMcpCredential({ name: 'Stdio', workspaceIds: ['own'], tools })
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
    const client = new Client({ name: 'tags-stdio', version: '1' })
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
      for (const name of tools) {
        expect(names.includes(name)).toBe(mode !== 'read-only')
        const result = await client.callTool({
          name,
          arguments: { tags: ['API'], ...(mode === 'external' ? { workspace_id: 'own' } : {}) },
        })
        expect(result.isError === true).toBe(mode === 'read-only')
        if (mode !== 'external')
          expect((await client.callTool({ name, arguments: { workspace_id: 'other', tags: ['API'] } })).isError).toBe(
            true,
          )
      }
      expect(getWorkspace('own')!.tags).toEqual(['existing'])
      revokeInternalMcpCapability(cap.token)
      if (mode !== 'external')
        expect((await client.callTool({ name: tools[0]!, arguments: { tags: ['API'] } })).isError).toBe(true)
    } finally {
      revokeInternalMcpCapability(cap.token)
      await client.close()
      if ('closeAllConnections' in listener) listener.closeAllConnections()
      await new Promise<void>((resolve) => listener.close(() => resolve()))
    }
  },
  20_000,
)
