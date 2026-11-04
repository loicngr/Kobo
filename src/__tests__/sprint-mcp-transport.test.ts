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
import {
  createExternalMcpCredential,
  revokeExternalMcpCredential,
} from '../server/services/external-mcp-credentials-service.js'
import { createSprint } from '../server/services/sprint-service.js'
import { createWorkspace } from '../server/services/workspace-service.js'

let dir: string
let previous: string | undefined
beforeEach(() => {
  closeDb()
  previous = process.env.KOBO_HOME
  dir = mkdtempSync(join(tmpdir(), 'sprint-mcp-'))
  process.env.KOBO_HOME = dir
  runMigrations(getDb(join(dir, 'test.db')))
})
afterEach(() => {
  closeDb()
  if (previous === undefined) delete process.env.KOBO_HOME
  else process.env.KOBO_HOME = previous
  rmSync(dir, { recursive: true, force: true })
})
it.each(['http', 'stdio'])(
  'enforces sprint grants and scopes through %s',
  async (transport) => {
    const one = createWorkspace({ name: 'one', projectPath: '/tmp', sourceBranch: 'main', workingBranch: 'one' })
    const two = createWorkspace({ name: 'two', projectPath: '/tmp', sourceBranch: 'main', workingBranch: 'two' })
    const sprint = createSprint('Sprint')
    const key = createExternalMcpCredential({
      name: 'scoped',
      workspaceIds: [one.id],
      tools: ['list_sprints', 'get_workspace_sprint', 'assign_workspace_sprint', 'create_sprint', 'list_workspaces'],
    })
    const app = new Hono().route('/api/mcp', mcp)
    const listener = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
    if (!listener.listening) await new Promise<void>((resolve) => listener.once('listening', resolve))
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('No listener')
    const url = `http://127.0.0.1:${address.port}`
    const client = new Client({ name: 'sprints-test', version: '1' })
    try {
      await client.connect(
        transport === 'http'
          ? new StreamableHTTPClientTransport(new URL(`${url}/api/mcp`), {
              requestInit: { headers: { Authorization: `Bearer ${key.token}` } },
            })
          : new StdioClientTransport({
              command: process.execPath,
              args: ['--import', 'tsx', 'src/mcp-server/kobo-tasks-server.ts'],
              env: { PATH: process.env.PATH ?? '', KOBO_MCP_TOKEN: key.token, KOBO_BACKEND_URL: url },
              stderr: 'pipe',
            }),
      )
      const names = (await client.listTools()).tools.map((item) => item.name)
      expect(names).toContain('assign_workspace_sprint')
      expect(names).not.toContain('create_sprint')
      const list = await client.callTool({ name: 'list_sprints', arguments: {} })
      expect(JSON.parse((list.content as { text: string }[])[0].text)).toEqual({
        sprints: [{ id: sprint.id, name: sprint.name }],
      })
      expect(
        (
          await client.callTool({
            name: 'assign_workspace_sprint',
            arguments: { workspace_id: one.id, sprint_id: sprint.id },
          })
        ).isError,
      ).not.toBe(true)
      expect(
        (
          await client.callTool({
            name: 'assign_workspace_sprint',
            arguments: { workspace_id: two.id, sprint_id: sprint.id },
          })
        ).isError,
      ).toBe(true)
      expect((await client.callTool({ name: 'create_sprint', arguments: { name: 'No' } })).isError).toBe(true)
      const workspaces = await client.callTool({ name: 'list_workspaces', arguments: { sprint_id: sprint.id } })
      expect(
        JSON.parse((workspaces.content as { text: string }[])[0].text).map((item: { id: string }) => item.id),
      ).toEqual([one.id])
      revokeExternalMcpCredential(key.credential.id)
      if (transport === 'http') await expect(client.callTool({ name: 'list_sprints', arguments: {} })).rejects.toThrow()
      else expect((await client.callTool({ name: 'list_sprints', arguments: {} })).isError).toBe(true)
    } finally {
      await client.close()
      await new Promise<void>((resolve) => listener.close(() => resolve()))
    }
  },
  15000,
)

it('requires both global scope and the matching grant for catalogue mutation', async () => {
  const app = new Hono().route('/api/mcp', mcp)
  const scoped = createExternalMcpCredential({ name: 'scoped', workspaceIds: ['one'], tools: ['create_sprint'] })
  const global = createExternalMcpCredential({ name: 'global', allWorkspaces: true, tools: ['create_sprint'] })
  const reader = createExternalMcpCredential({ name: 'reader', allWorkspaces: true, tools: ['list_sprints'] })
  const call = async (token: string, name: string, args: Record<string, unknown>) =>
    (
      await app.request('/api/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      })
    ).json()
  expect((await call(scoped.token, 'create_sprint', { name: 'No' })).result.isError).toBe(true)
  expect((await call(reader.token, 'create_sprint', { name: 'No' })).result.isError).toBe(true)
  expect((await call(global.token, 'create_sprint', { name: 'Yes' })).result.isError).not.toBe(true)
})
