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

const mocks = vi.hoisted(() => ({ start: vi.fn(), get: vi.fn() }))
vi.mock('../server/services/workspace-group-message-service.js', () => ({
  startGroupMessageBatch: mocks.start,
  getGroupMessageBatch: mocks.get,
  GroupMessageError: class extends Error {},
}))
const receipt = {
  id: 'group-test',
  createdAt: 'now',
  complete: false,
  recipients: [{ workspaceId: 'other', name: 'Other', delivery: 'immediate', state: 'pending' }],
}
const args = { request_id: 'group-test', workspace_ids: ['other'], content: 'Bonjour' }
const app = new Hono().route('/api/mcp', mcp)
let directory: string
beforeEach(() => {
  vi.resetAllMocks()
  directory = mkdtempSync(join(tmpdir(), 'kobo-group-mcp-'))
  closeDb()
  runMigrations(getDb(join(directory, 'test.db')))
  for (const status of ['running', 'starting', 'stopped', 'stopping', 'error', 'unknown']) {
    getDb()
      .prepare(`INSERT INTO workspaces
      (id,name,project_path,source_branch,working_branch,status,dev_server_status,created_at,updated_at)
      VALUES (?,?,'/tmp','main','work','idle',?,'now','now')`)
      .run(status, status, status)
  }
  mocks.start.mockReturnValue(receipt)
  mocks.get.mockReturnValue(receipt)
})
afterEach(() => {
  closeDb()
  rmSync(directory, { recursive: true, force: true })
})
function data(result: Awaited<ReturnType<Client['callTool']>>) {
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text)
}
async function exercise(client: Client, transport: 'http' | 'stdio') {
  const names = (await client.listTools()).tools.map((tool) => tool.name)
  expect(names).toContain('preview_workspace_group_message')
  expect(names).toContain('send_workspace_group_message')
  expect(names).toContain('get_workspace_group_message')
  const preview = await client.callTool({
    name: 'preview_workspace_group_message',
    arguments: { statuses: ['idle'], dev_server_running: true },
  })
  expect(data(preview)).toMatchObject({ total: 1, recipients: [{ workspaceId: 'running' }] })
  const sent = await client.callTool({ name: 'send_workspace_group_message', arguments: args })
  expect(sent.isError).not.toBe(true)
  expect(data(sent)).toEqual(receipt)
  expect(mocks.start).toHaveBeenCalledWith(
    { requestId: args.request_id, workspaceIds: args.workspace_ids, content: args.content },
    { kind: 'mcp', clientName: 'Équipe', transport },
  )
  expect(
    data(await client.callTool({ name: 'get_workspace_group_message', arguments: { request_id: args.request_id } })),
  ).toEqual(receipt)
  const invalid = await client.callTool({
    name: 'send_workspace_group_message',
    arguments: { ...args, workspace_ids: [] },
  })
  expect(invalid.isError).toBe(true)
  expect(mocks.start).toHaveBeenCalledTimes(1)
}
it('exposes group preview/send/status over HTTP with structured validation errors', async () => {
  const client = new Client({ name: 'group-http', version: '1' })
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://localhost/api/mcp'), {
        fetch: async (input, init) => app.fetch(new Request(input, init)),
        requestInit: {
          headers: { 'X-Kobo-Client-Name': encodeURIComponent('Équipe'), 'X-Kobo-Client-Name-Encoding': 'uri' },
        },
      }),
    )
    await exercise(client, 'http')
    mocks.get.mockReturnValue(undefined)
    const missing = await client.callTool({ name: 'get_workspace_group_message', arguments: { request_id: 'missing' } })
    expect(missing.isError).toBe(true)
    expect(data(missing)).toMatchObject({ status: 404 })
  } finally {
    await client.close()
  }
})
it.each(['global', 'workspace', 'review', 'handoff'])(
  'supports %s stdio with workspace and read-only guards',
  async (mode) => {
    const listener = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
    if (!listener.listening) await new Promise<void>((resolve) => listener.once('listening', resolve))
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('Missing listener')
    const client = new Client({ name: 'Équipe', version: '1' })
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ['--import', 'tsx', 'src/mcp-server/kobo-tasks-server.ts'],
          env: {
            PATH: process.env.PATH ?? '',
            KOBO_HOME: directory,
            KOBO_DB_PATH: getDb().name,
            KOBO_WORKSPACE_ID: mode === 'global' ? '' : 'self',
            KOBO_BACKEND_URL: `http://127.0.0.1:${address.port}`,
            ...(mode === 'review' ? { KOBO_FINAL_REVIEW_TOKEN: 'token', KOBO_FINAL_REVIEW_SESSION_ID: 'session' } : {}),
            ...(mode === 'handoff' ? { KOBO_HANDOFF_ID: 'handoff', KOBO_HANDOFF_TOKEN: 'token' } : {}),
          },
          stderr: 'pipe',
        }),
      )
      if (mode === 'review' || mode === 'handoff') {
        const names = (await client.listTools()).tools.map((tool) => tool.name)
        expect(names).toContain('preview_workspace_group_message')
        expect(names).toContain('get_workspace_group_message')
        expect(names).not.toContain('send_workspace_group_message')
        expect((await client.callTool({ name: 'send_workspace_group_message', arguments: args })).isError).toBe(true)
        expect(
          data(
            await client.callTool({ name: 'get_workspace_group_message', arguments: { request_id: args.request_id } }),
          ),
        ).toEqual(receipt)
        expect(mocks.start).not.toHaveBeenCalled()
      } else {
        await exercise(client, 'stdio')
        if (mode === 'workspace') {
          expect(
            (
              await client.callTool({
                name: 'send_workspace_group_message',
                arguments: { ...args, workspace_ids: ['other', 'self'] },
              })
            ).isError,
          ).toBe(true)
          expect(mocks.start).toHaveBeenCalledTimes(1)
        }
      }
    } finally {
      await client.close()
      await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())))
    }
  },
  15_000,
)
