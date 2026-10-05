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
import mcp from '../server/routes/mcp.js'
import memory from '../server/routes/memory.js'
import { _setSettingsPath, updateGlobalSettings } from '../server/services/settings-service.js'

const app = new Hono().route('/api/mcp', mcp).route('/api/memory', memory)
let directory: string

beforeEach(() => {
  closeDb()
  directory = mkdtempSync(join(tmpdir(), 'kobo-memory-transport-share-'))
  _setSettingsPath(join(directory, 'settings.json'))
  runMigrations(getDb(join(directory, 'test.db')))
})

afterEach(() => {
  closeDb()
  rmSync(directory, { recursive: true, force: true })
})

interface McpPayload {
  items?: Array<{ id: string; level?: string; generation?: number }>
  memory_context_id?: string
  status?: string
  entry?: { id: string; key?: string; body?: string }
}

function parse(result: unknown): McpPayload {
  const content = result && typeof result === 'object' && 'content' in result ? result.content : []
  const text = Array.isArray(content) ? content.find((block) => block.type === 'text')?.text : undefined
  return JSON.parse(text ?? 'null') as McpPayload
}

it('shares the same memory scope and entry between stateless HTTP and global stdio without a native session', async () => {
  const listener = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  if (!listener.listening) await new Promise<void>((resolve) => listener.once('listening', resolve))
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('Missing test listener address')
  const httpClient = new Client({ name: 'HTTP writer', version: '1' })
  const httpTransport = new StreamableHTTPClientTransport(new URL('http://localhost/api/mcp'), {
    fetch: async (input, init) => app.fetch(new Request(input, init)),
  })
  const stdioClient = new Client({ name: 'stdio reader', version: '1' })
  try {
    await httpClient.connect(httpTransport)
    const httpScopes = parse(await httpClient.callTool({ name: 'list_memory_scopes', arguments: {} }))
    const global = httpScopes.items?.find((scope) => scope.level === 'global')
    if (!global) throw new Error('External scope catalogue did not contain the global scope')
    expect(global).toMatchObject({ generation: 0, revision: 0 })
    if (typeof global.generation !== 'number') throw new Error('External scope catalogue omitted its CAS generation')
    updateGlobalSettings({ memoryMode: 'automatic' })
    const saved = parse(
      await httpClient.callTool({
        name: 'remember',
        arguments: {
          memory_context_id: httpScopes.memory_context_id,
          scope_id: global.id,
          expected_generation: global.generation,
          key: 'cross.transport.fact',
          title: 'Shared transport fact',
          body: 'Shared memory crosses HTTP and stdio.',
        },
      }),
    )
    expect(saved).toMatchObject({ status: 'applied' })
    const written = parse(
      await httpClient.callTool({
        name: 'list_memories',
        arguments: { memory_context_id: httpScopes.memory_context_id, scope_id: global.id },
      }),
    )
    const created = written.items?.find((entry) => entry.id)
    if (!created) throw new Error('The HTTP memory list did not contain its newly saved entry')

    await stdioClient.connect(
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
          KOBO_MCP_CLIENT_NAME: 'stdio reader',
        },
        stderr: 'pipe',
      }),
    )
    const stdioScopes = parse(await stdioClient.callTool({ name: 'list_memory_scopes', arguments: {} }))
    expect(stdioScopes.items?.map((scope) => scope.id)).toEqual(httpScopes.items?.map((scope) => scope.id))
    expect(stdioScopes.items?.[0]?.id).toBe(global.id)
    const read = parse(
      await stdioClient.callTool({
        name: 'read_memory',
        arguments: { scope_id: global.id, entry_id: created.id },
      }),
    )
    expect(read.entry).toMatchObject({ key: 'cross.transport.fact', body: 'Shared memory crosses HTTP and stdio.' })

    const previewResponse = await app.request(`/api/memory/scopes/${global.id}/clear-preview`)
    const preview = (await previewResponse.json()) as { revision: number }
    const cleared = await app.request(`/api/memory/scopes/${global.id}/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: preview.revision }),
    })
    expect(cleared.status).toBe(200)
    const lateWrite = await httpClient.callTool({
      name: 'remember',
      arguments: {
        memory_context_id: httpScopes.memory_context_id,
        scope_id: global.id,
        expected_generation: global.generation,
        key: 'cross.transport.late',
        title: 'Late write',
        body: 'Must be rejected after clear.',
      },
    })
    expect(lateWrite.isError).toBe(true)
    expect(JSON.stringify(parse(lateWrite))).toMatch(/generation changed/i)
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM memory_entries WHERE scope_id = ?').get(global.id)).toEqual({
      count: 0,
    })
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM agent_sessions').get()).toEqual({ count: 0 })
  } finally {
    await httpClient.close()
    await stdioClient.close()
    await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())))
  }
}, 15_000)
