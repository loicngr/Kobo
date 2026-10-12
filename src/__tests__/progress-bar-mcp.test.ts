import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: undefined as unknown as Database.Database }))
vi.mock('../server/db/index.js', () => ({ getDb: () => state.db }))
vi.mock('../server/services/websocket-service.js', () => ({ emitEphemeral: vi.fn() }))

import { callProgressBarTool } from '../mcp-server/progress-bar-client.js'
import { initSchema } from '../server/db/schema.js'
import { executeProgressBarTool } from '../server/services/progress-bar-mcp-service.js'
import {
  closeProgressCapability,
  createProgressCapability,
  resolveProgressCapability,
  revokeProgressCapability,
} from '../server/services/progress-bar-runtime.js'
import { listProgressBars } from '../server/services/progress-bar-service.js'

beforeEach(() => {
  state.db = new Database(':memory:')
  initSchema(state.db)
  for (const id of ['1', '2']) {
    state.db
      .prepare(
        "INSERT INTO workspaces(id,name,project_path,source_branch,working_branch,created_at,updated_at) VALUES (?,?,'/tmp','main','feature','now','now')",
      )
      .run(`w${id}`, id)
    state.db
      .prepare("INSERT INTO agent_sessions(id,workspace_id,started_at) VALUES (?,?,'now')")
      .run(`s${id}`, `w${id}`)
  }
})
afterEach(() => {
  if (state.db.open) state.db.close()
})
const args = { workspace_id: 'w1', session_id: 's1', activity_key: 'tests', label: 'Tests' }
it('uses the same scoped service externally and internally; rejects forged arguments', () => {
  const external = executeProgressBarTool('create_progress_bar', args)
  expect(external).toMatchObject({ label: 'Tests', sessionId: 's1' })
  const cap = createProgressCapability('w1', 's1')
  expect(
    executeProgressBarTool(
      'create_progress_bar',
      { activity_key: 'tests', label: 'Internal' },
      resolveProgressCapability(cap.token),
    ),
  ).toMatchObject({ label: 'Internal' })
  expect(() => executeProgressBarTool('create_progress_bar', args, resolveProgressCapability(cap.token))).toThrow(
    /Unknown/,
  )
  expect(() => executeProgressBarTool('create_progress_bar', { ...args, session_id: 's2' })).toThrow()
  expect(() =>
    executeProgressBarTool('update_progress_bar', {
      workspace_id: 'w1',
      session_id: 's1',
      progress_id: 'x',
      sequence: 1,
      extra: true,
    }),
  ).toThrow(/Unknown/)
  closeProgressCapability(cap)
})
it('revokes immediately but interrupts only the exact launch on actual closure', () => {
  const first = createProgressCapability('w1', 's1')
  executeProgressBarTool(
    'create_progress_bar',
    { activity_key: 'one', label: 'One' },
    resolveProgressCapability(first.token),
  )
  revokeProgressCapability(first.token)
  expect(() => resolveProgressCapability(first.token)).toThrow(/capability/i)
  expect(listProgressBars({ workspaceId: 'w1', sessionId: 's1' }).items[0].status).toBe('running')
  const second = createProgressCapability('w1', 's1')
  executeProgressBarTool(
    'create_progress_bar',
    { activity_key: 'two', label: 'Two' },
    resolveProgressCapability(second.token),
  )
  closeProgressCapability(first)
  expect(listProgressBars({ workspaceId: 'w1', sessionId: 's1' }).items.map((b) => [b.label, b.status])).toEqual(
    expect.arrayContaining([
      ['One', 'interrupted'],
      ['Two', 'running'],
    ]),
  )
  closeProgressCapability(second)
})
it('does not reopen the database when a late close follows shutdown', () => {
  const cap = createProgressCapability('w1', 's1')
  state.db.close()
  expect(() => closeProgressCapability(cap)).not.toThrow()
  expect(() => resolveProgressCapability(cap.token)).toThrow()
})
it('workspace bridge fails closed without capability and preserves structured errors', async () => {
  const fetcher = vi.fn()
  await expect(
    callProgressBarTool({ backendUrl: 'http://localhost', name: 'create_progress_bar', args: {}, fetcher }),
  ).rejects.toThrow(/capability/i)
  expect(fetcher).not.toHaveBeenCalled()
  fetcher.mockResolvedValue(
    new Response(JSON.stringify({ error: 'Slow down', code: 'rate_limited', retryAfterMs: 1000 }), { status: 429 }),
  )
  const response = await callProgressBarTool({
    backendUrl: 'http://localhost',
    name: 'update_progress_bar',
    args: { progress_id: 'p', sequence: 1 },
    capability: 'secret',
    fetcher,
  })
  expect(response).toMatchObject({ isError: true, structuredContent: { code: 'rate_limited', retryAfterMs: 1000 } })
})
