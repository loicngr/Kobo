import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ db: undefined as unknown as Database.Database }))
vi.mock('../server/db/index.js', () => ({ getDb: () => runtime.db }))
vi.mock('../server/services/agent/orchestrator.js', () => ({
  sendMessage: vi.fn(async (_id: string, _content: string, _session: unknown, before?: () => void) => before?.()),
  startAgent: vi.fn(),
  isShuttingDown: () => false,
  isAgentUnavailableError: () => false,
}))
vi.mock('../server/services/auto-loop-service.js', () => ({
  getStatus: vi.fn(() => ({ auto_loop: false })),
  disable: vi.fn(),
  queueInstruction: vi.fn((id: string, content: string, clientMessageId: string) => {
    const row = runtime.db.prepare('SELECT auto_loop FROM workspaces WHERE id=?').get(id) as { auto_loop: number }
    if (!row?.auto_loop) return false
    runtime.db
      .prepare('INSERT INTO auto_loop_messages(workspace_id,client_message_id,content,created_at) VALUES (?,?,?,?)')
      .run(id, clientMessageId, content, 'now')
    return true
  }),
}))
vi.mock('../server/services/workspace-service.js', () => ({
  getWorkspace: (id: string) =>
    runtime.db
      .prepare(
        'SELECT id,name,auto_loop AS autoLoop,archived_at AS archivedAt,worktree_purged_at AS worktreePurgedAt,status FROM workspaces WHERE id=?',
      )
      .get(id),
  getActiveSession: () => undefined,
  updateWorkspaceStatus: vi.fn(),
}))

import { runMigrations } from '../server/db/migrations.js'
import router from '../server/routes/workspace-messages.js'
import * as agent from '../server/services/agent/orchestrator.js'
import * as loop from '../server/services/auto-loop-service.js'
import * as websocket from '../server/services/websocket-service.js'
import {
  getGroupMessageBatch,
  reconcileGroupMessageBatches,
  startGroupMessageBatch,
  stopGroupMessageBatches,
} from '../server/services/workspace-group-message-service.js'
import { matchesGroupMessageFilters, parseGroupMessageInput } from '../shared/workspace-group-messages.js'

beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  runtime.db = new Database(':memory:')
  runtime.db.pragma('foreign_keys=ON')
  runMigrations(runtime.db)
  reconcileGroupMessageBatches(runtime.db)
  for (const id of ['a', 'b', 'c', 'd'])
    runtime.db
      .prepare(
        "INSERT INTO workspaces(id,name,project_path,source_branch,working_branch,created_at,updated_at) VALUES (?,?,'/tmp','main','work','now','now')",
      )
      .run(id, id)
  vi.mocked(agent.sendMessage).mockImplementation(async (_id, _content, _session, before) => {
    before?.()
  })
})
afterEach(async () => {
  await stopGroupMessageBatches()
  runtime.db.close()
})
const input = (requestId = 'request-1') => ({ requestId, workspaceIds: ['a', 'b'], content: 'hello' })
async function completed(id: string) {
  await vi.waitFor(() => expect(getGroupMessageBatch(id)?.complete).toBe(true))
  return getGroupMessageBatch(id)!
}

it('stores exact recipients and delivers immediate/queued independently without disabling a loop', async () => {
  runtime.db.prepare('UPDATE workspaces SET auto_loop=1 WHERE id=?').run('b')
  const batch = startGroupMessageBatch(input())
  expect(batch.recipients.map((r) => [r.workspaceId, r.delivery])).toEqual([
    ['a', 'immediate'],
    ['b', 'next_iteration'],
  ])
  expect((await completed(batch.id)).recipients.map((r) => r.state)).toEqual(['sent', 'queued'])
  expect(agent.sendMessage).toHaveBeenCalledTimes(1)
  expect(loop.disable).not.toHaveBeenCalled()
  expect(runtime.db.prepare("SELECT COUNT(*) AS count FROM ws_events WHERE type='user:message'").get()).toEqual({
    count: 2,
  })
})
it('returns identical receipts on retry and rejects changed payload without redispatch', async () => {
  const first = startGroupMessageBatch(input())
  await completed(first.id)
  expect(startGroupMessageBatch(input())).toEqual(getGroupMessageBatch(first.id))
  expect(() => startGroupMessageBatch({ ...input(), content: 'changed' })).toThrow(/different/i)
  expect(agent.sendMessage).toHaveBeenCalledTimes(2)
})
it('caps concurrent delivery across batches, keeping submission nonblocking', async () => {
  const releases: Array<() => void> = []
  vi.mocked(agent.sendMessage).mockImplementation(async (_id, _content, _session, before) => {
    before?.()
    await new Promise<void>((r) => releases.push(r))
  })
  const first = startGroupMessageBatch({ ...input(), workspaceIds: ['a', 'b', 'c', 'd'] })
  const second = startGroupMessageBatch(input('request-2'))
  await vi.waitFor(() => expect(releases.length).toBe(3))
  expect(getGroupMessageBatch(first.id)?.complete).toBe(false)
  expect(getGroupMessageBatch(second.id)?.complete).toBe(false)
  while (!getGroupMessageBatch(second.id)?.complete) {
    releases.splice(0).forEach((r) => {
      r()
    })
    await new Promise((r) => setTimeout(r, 0))
  }
  expect(agent.sendMessage).toHaveBeenCalledTimes(6)
})
it('rejects missing, archived and purged recipients individually', async () => {
  runtime.db.prepare("UPDATE workspaces SET archived_at='now' WHERE id='a'").run()
  runtime.db.prepare("UPDATE workspaces SET worktree_purged_at='now' WHERE id='b'").run()
  const batch = startGroupMessageBatch({ ...input(), workspaceIds: ['a', 'b', 'missing', 'c'] })
  expect((await completed(batch.id)).recipients.map((r) => r.state)).toEqual([
    'rejected',
    'rejected',
    'rejected',
    'sent',
  ])
})
it('does not turn a queued delivery into an immediate message when auto-loop is disabled', async () => {
  runtime.db.prepare("UPDATE workspaces SET auto_loop=1 WHERE id='b'").run()
  const batch = startGroupMessageBatch(input())
  runtime.db.prepare("UPDATE workspaces SET auto_loop=0 WHERE id='b'").run()
  expect((await completed(batch.id)).recipients[1].state).toBe('rejected')
  expect(agent.sendMessage).toHaveBeenCalledTimes(1)
})
it('distinguishes rejected delivery from unknown after dispatch', async () => {
  vi.mocked(agent.sendMessage).mockImplementation(async (id, _content, _session, before) => {
    if (id === 'b') before?.()
    throw new Error('delivery broke')
  })
  expect((await completed(startGroupMessageBatch(input()).id)).recipients.map((r) => r.state)).toEqual([
    'rejected',
    'unknown',
  ])
})
it('reconciles interrupted receipts without retrying any target', async () => {
  const receipt = {
    id: 'interrupted',
    createdAt: 'now',
    complete: false,
    recipients: [
      { workspaceId: 'a', name: 'a', delivery: 'immediate', state: 'pending' },
      { workspaceId: 'b', name: 'b', delivery: 'immediate', state: 'sending' },
    ],
  }
  runtime.db
    .prepare('INSERT INTO workspace_message_batches(id,fingerprint,receipt_json,created_at) VALUES (?,?,?,?)')
    .run('interrupted', 'hash', JSON.stringify(receipt), 'now')
  reconcileGroupMessageBatches(runtime.db)
  expect(getGroupMessageBatch('interrupted')?.recipients.map((r) => r.state)).toEqual(['not_sent', 'unknown'])
  expect(getGroupMessageBatch('interrupted')?.complete).toBe(true)
  expect(agent.sendMessage).not.toHaveBeenCalled()
})
it('validates strict bounded requests and filters OR within tags/statuses, AND between them', () => {
  for (const value of [
    { ...input(), extra: 1 },
    { ...input(), content: ' ' },
    { ...input(), content: 'x'.repeat(100001) },
    { ...input(), workspaceIds: ['a', 'a'] },
    { ...input(), workspaceIds: [] },
    { ...input(), workspaceIds: Array.from({ length: 201 }, (_, i) => `ws-${i}`) },
  ])
    expect(() => parseGroupMessageInput(value)).toThrow()
  expect(parseGroupMessageInput(input())).toEqual(input())
  expect(
    matchesGroupMessageFilters(
      { tags: ['one'], status: 'idle' },
      { tags: ['one', 'two'], statuses: ['idle', 'error'] },
    ),
  ).toBe(true)
  expect(
    matchesGroupMessageFilters({ tags: ['one'], status: 'executing' }, { tags: ['one'], statuses: ['idle'] }),
  ).toBe(false)
})
it('serves 202/receipt and rejects malformed or over-budget requests', async () => {
  const response = await router.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input()),
  })
  expect(response.status).toBe(202)
  const batch = (await response.json()) as { id: string }
  expect((await router.request(`/${batch.id}`)).status).toBe(200)
  expect((await router.request('/missing')).status).toBe(404)
  expect((await router.request('/', { method: 'POST', body: 'oops' })).status).toBe(400)
  expect((await router.request('/', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) })).status).toBe(413)
  await completed(batch.id)
})

it('stops pending deliveries on shutdown and preserves completed receipts', async () => {
  const releases: Array<() => void> = []
  vi.mocked(agent.sendMessage).mockImplementation(async (_id, _content, _session, before) => {
    before?.()
    await new Promise<void>((r) => releases.push(r))
  })
  const batch = startGroupMessageBatch({ ...input(), workspaceIds: ['a', 'b', 'c', 'd'] })
  await vi.waitFor(() => expect(releases).toHaveLength(3))
  const stopped = stopGroupMessageBatches()
  expect(getGroupMessageBatch(batch.id)?.recipients[3].state).toBe('not_sent')
  expect(() => startGroupMessageBatch(input('after-shutdown'))).toThrow(/shutting down/)
  releases.forEach((release) => {
    release()
  })
  await stopped
  expect(getGroupMessageBatch(batch.id)?.recipients.map((r) => r.state)).toEqual(['sent', 'sent', 'sent', 'not_sent'])
  expect(startGroupMessageBatch({ ...input(), workspaceIds: ['a', 'b', 'c', 'd'] })).toEqual(
    getGroupMessageBatch(batch.id),
  )
})
it('rolls back chat persistence when the durable batch receipt cannot commit', async () => {
  runtime.db.exec(
    "CREATE TRIGGER fail_sent_receipt BEFORE UPDATE ON workspace_message_batches WHEN NEW.receipt_json LIKE '%sent%' BEGIN SELECT RAISE(ABORT,'disk failure'); END",
  )
  const batch = startGroupMessageBatch({ ...input(), workspaceIds: ['a'] })
  expect((await completed(batch.id)).recipients[0].state).toBe('unknown')
  expect(runtime.db.prepare("SELECT COUNT(*) AS count FROM ws_events WHERE type='user:message'").get()).toEqual({
    count: 0,
  })
})
it('keeps a committed success if websocket notification fails', async () => {
  vi.spyOn(websocket, 'broadcastPersistedEvent').mockImplementation(() => {
    throw new Error('socket closed')
  })
  const batch = startGroupMessageBatch({ ...input(), workspaceIds: ['a'] })
  expect((await completed(batch.id)).recipients[0].state).toBe('sent')
  expect(runtime.db.prepare("SELECT COUNT(*) AS count FROM ws_events WHERE type='user:message'").get()).toEqual({
    count: 1,
  })
})
it('preserves authenticated MCP provenance in chat receipts', async () => {
  const source = { kind: 'mcp' as const, clientName: 'Client test', transport: 'http' as const }
  await completed(startGroupMessageBatch({ ...input(), workspaceIds: ['a'] }, source).id)
  const row = runtime.db.prepare("SELECT payload FROM ws_events WHERE type='user:message'").get() as { payload: string }
  expect(JSON.parse(row.payload).source).toEqual(source)
})
