import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { closeDb, getDb } from '../server/db/index.js'
import { runMigrations } from '../server/db/migrations.js'
import mcp from '../server/routes/mcp.js'
import { createExternalMcpCredential } from '../server/services/external-mcp-credentials-service.js'
import { clearMemoryScope, resolveMemoryScope } from '../server/services/memory-service.js'
import { _setSettingsPath, updateGlobalSettings } from '../server/services/settings-service.js'

let home: string
let previous: string | undefined
let token: string
beforeEach(() => {
  closeDb()
  previous = process.env.KOBO_HOME
  home = mkdtempSync(join(tmpdir(), 'kobo-scoped-memory-'))
  process.env.KOBO_HOME = home
  _setSettingsPath(join(home, 'settings.json'))
  runMigrations(getDb())
  for (const id of ['allowed', 'other'])
    getDb()
      .prepare(
        "INSERT INTO workspaces(id,name,project_path,source_branch,working_branch,created_at,updated_at) VALUES (?,?,'/tmp','main','work',datetime('now'),datetime('now'))",
      )
      .run(id, id)
  token = createExternalMcpCredential({
    name: 'Scoped memory',
    workspaceIds: ['allowed'],
    tools: ['list_memory_scopes', 'list_memories', 'remember'],
  }).token
})
afterEach(() => {
  closeDb()
  if (previous === undefined) delete process.env.KOBO_HOME
  else process.env.KOBO_HOME = previous
  rmSync(home, { recursive: true, force: true })
})
async function call(name: string, args: Record<string, unknown>) {
  const response = await mcp.request('http://localhost/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  const envelope = await response.json()
  return { result: envelope.result, data: JSON.parse(envelope.result.content[0].text) }
}
it('reads empty workspace memory before any scope was materialized', async () => {
  expect(getDb().prepare('SELECT count(*) n FROM memory_scopes').get()).toEqual({ n: 0 })
  const read = await call('list_memories', { workspace_id: 'allowed' })
  expect(read.result.isError).not.toBe(true)
  expect(read.data.items).toEqual([])
  expect(getDb().prepare('SELECT level,workspace_id FROM memory_scopes').all()).toEqual([
    { level: 'workspace', workspace_id: 'allowed' },
  ])
})
it('discovers only authorized workspace scopes and exposes the current generation for writes', async () => {
  const catalogue = await call('list_memory_scopes', {})
  expect(catalogue.result.isError).not.toBe(true)
  expect(catalogue.data.items).toHaveLength(1)
  const scope = catalogue.data.items[0]
  expect(scope).toMatchObject({ level: 'workspace', generation: 0, revision: 0 })
  expect(getDb().prepare('SELECT level,workspace_id FROM memory_scopes').all()).toEqual([
    { level: 'workspace', workspace_id: 'allowed' },
  ])
  expect((await call('list_memory_scopes', { workspace_id: 'other' })).result.isError).toBe(true)
  updateGlobalSettings({ memoryMode: 'automatic' })
  const cleared = clearMemoryScope({ scopeId: scope.id, expectedRevision: scope.revision, actor: { kind: 'human' } })
  const refreshed = await call('list_memory_scopes', { workspace_id: 'allowed' })
  expect(refreshed.data.items[0].generation).toBe(cleared.scope.generation)
  const saved = await call('remember', {
    scope_id: scope.id,
    expected_generation: refreshed.data.items[0].generation,
    key: 'decision',
    title: 'Decision',
    body: 'Synthetic test',
  })
  expect(saved.result.isError).not.toBe(true)
  expect(saved.data.status).toBe('applied')
})

it('never reveals existing global, project or foreign workspace metadata in scoped discovery', async () => {
  const global = resolveMemoryScope({ level: 'global' })
  const other = resolveMemoryScope({ level: 'workspace', workspaceId: 'other' })
  const catalogue = await call('list_memory_scopes', {})
  expect(catalogue.result.isError).not.toBe(true)
  expect(catalogue.data.items).toHaveLength(1)
  expect(catalogue.data.items[0].level).toBe('workspace')
  expect(JSON.stringify(catalogue.data)).not.toContain(global.id)
  expect(JSON.stringify(catalogue.data)).not.toContain(other.id)
  expect((await call('list_memories', { scope_id: global.id })).result.isError).toBe(true)
  expect((await call('list_memories', { scope_id: other.id })).result.isError).toBe(true)
})
