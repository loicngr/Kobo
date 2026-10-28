import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, getDb } from '../server/db/index.js'
import { initSchema } from '../server/db/schema.js'
import {
  createPinnedMessage,
  deletePinnedMessage,
  getPinnedMessage,
  listPinnedMessages,
} from '../server/services/pinned-message-service.js'
import { _getClients, broadcastAll } from '../server/services/websocket-service.js'

vi.mock('../server/services/websocket-service.js', async (original) => {
  const service = await original<typeof import('../server/services/websocket-service.js')>()
  return { ...service, broadcastAll: vi.fn(service.broadcastAll) }
})

function event(
  id: string,
  payload: Record<string, unknown>,
  session: string | null = 's1',
  workspace = 'w1',
  type = 'agent:event',
) {
  getDb()
    .prepare('INSERT INTO ws_events VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, workspace, type, JSON.stringify(payload), session, '2026-10-28T10:00:00Z')
}

let directory: string
beforeEach(() => {
  vi.clearAllMocks()
  closeDb()
  directory = mkdtempSync(join(tmpdir(), 'kobo-pins-test-'))
  const db = getDb(join(directory, 'test.db'))
  initSchema(db)
  for (const id of ['w1', 'w2'])
    db.prepare(
      'INSERT INTO workspaces (id,name,project_path,source_branch,working_branch,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, id, '/tmp', 'main', id, 'now', 'now')
  for (const [id, workspace, native, started] of [
    ['s1', 'w1', 'native1', '1'],
    ['s2', 'w1', 'native2', '2'],
    ['s3', 'w2', 'native3', '3'],
  ])
    db.prepare('INSERT INTO agent_sessions (id,workspace_id,engine_session_id,started_at) VALUES (?,?,?,?)').run(
      id,
      workspace,
      native,
      started,
    )
})
afterEach(() => {
  _getClients().clear()
  closeDb()
  rmSync(directory, { recursive: true, force: true })
})

describe('pinned messages', () => {
  it('invalidates both unsubscribed dashboards for archived pin creation and deletion without broadcasting content', () => {
    const clients = [vi.fn(), vi.fn()]
    for (const send of clients) {
      _getClients().set({ readyState: 1, bufferedAmount: 0, send } as unknown as import('ws').WebSocket, new Set())
    }
    getDb().exec("UPDATE workspaces SET archived_at='now' WHERE id='w1'")
    event('u', { content: 'private saved content', sender: 'user' }, 's1', 'w1', 'user:message')
    const pin = createPinnedMessage({ workspaceId: 'w1', eventIds: ['u'] })
    deletePinnedMessage(pin.id)
    deletePinnedMessage(pin.id)
    for (const send of clients) {
      expect(send.mock.calls.map(([frame]) => JSON.parse(frame))).toEqual([
        { type: 'pins:changed', payload: { workspaceId: 'w1' } },
        { type: 'pins:changed', payload: { workspaceId: 'w1' } },
      ])
    }
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM ws_events').get()).toEqual({ count: 1 })
  })
  it('captures complete selected logical text and tools from server events, immutably and idempotently', () => {
    event('a', { kind: 'message:text', messageId: 'm', text: '**Hello** ' })
    event('b', { kind: 'message:text', messageId: 'm', text: 'world' })
    event('c', { kind: 'tool:call', toolCallId: 't', name: 'Bash', input: { command: 'pwd' } })
    event('d', { kind: 'tool:result', toolCallId: 't', output: '/tmp', isError: false })
    const pin = createPinnedMessage({ workspaceId: 'w1', sessionId: 's1', eventIds: ['b', 'c'] })
    expect(pin).toMatchObject({
      workspaceId: 'w1',
      sessionId: 's1',
      eventId: 'a',
      itemKeys: ['text:m', 'tool:t'],
      speaker: 'agent',
      preview: 'Hello world',
      sourceAvailable: true,
    })
    expect(getPinnedMessage(pin.id).events.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd'])
    event('e', { kind: 'message:text', messageId: 'm', text: ' later' })
    expect(createPinnedMessage({ workspaceId: 'w1', eventIds: ['a'] }).id).toBe(pin.id)
    expect(getPinnedMessage(pin.id).events).toHaveLength(4)
    expect(broadcastAll).toHaveBeenCalledTimes(1)
    expect(broadcastAll).toHaveBeenCalledWith('pins:changed', { workspaceId: 'w1' })
  })
  it('rejects missing, foreign, mixed-session, mixed-speaker and invisible events without writing', () => {
    event('a', { kind: 'message:text', messageId: 'm', text: 'a' })
    event('b', { kind: 'message:text', messageId: 'm2', text: 'b' }, 's2')
    event('c', { kind: 'message:text', messageId: 'm3', text: 'c' }, 's3', 'w2')
    event('d', { kind: 'usage', inputTokens: 5 })
    event('u', { content: 'hello', sender: 'user' }, 's1', 'w1', 'user:message')
    event('sys', { content: 'secret prompt', sender: 'system-prompt' }, 's1', 'w1', 'user:message')
    for (const ids of [['missing'], ['c'], ['a', 'b'], ['a', 'u'], ['d'], ['sys']])
      expect(() => createPinnedMessage({ workspaceId: 'w1', eventIds: ids })).toThrow()
    expect(() => createPinnedMessage({ workspaceId: 'w1', eventIds: ['a'], sessionId: 's2' })).toThrow()
    expect(listPinnedMessages().pins).toHaveLength(0)
  })
  it('resolves native and legacy null sessions without crossing workspaces', () => {
    event('a', { kind: 'message:text', messageId: 'm', text: 'a' }, 'native1')
    event('b', { kind: 'message:text', messageId: 'm', text: 'b' }, null)
    expect(createPinnedMessage({ workspaceId: 'w1', eventIds: ['a', 'b'], sessionId: 's1' }).sessionId).toBe('s1')
    expect(() => createPinnedMessage({ workspaceId: 'w2', eventIds: ['a'], sessionId: 'native1' })).toThrow()
    event('orphan', { kind: 'message:text', messageId: 'o', text: 'orphan' }, 'missing')
    expect(() => createPinnedMessage({ workspaceId: 'w1', eventIds: ['orphan'] })).toThrow()
    getDb().exec("DELETE FROM agent_sessions WHERE id='s1'")
    expect(listPinnedMessages().pins).toHaveLength(0)
  })
  it('keeps snapshots after retention/archive/purge and cascades session or workspace deletion', () => {
    event('u', { content: 'hello', sender: 'user' }, 's1', 'w1', 'user:message')
    const pin = createPinnedMessage({ workspaceId: 'w1', eventIds: ['u'] })
    getDb().exec(
      "DELETE FROM ws_events; UPDATE workspaces SET archived_at='now', worktree_purged_at='now' WHERE id='w1'",
    )
    expect(getPinnedMessage(pin.id)).toMatchObject({
      pin: { sourceAvailable: false, archived: true },
      events: [{ id: 'u', payload: { content: 'hello' } }],
    })
    expect(listPinnedMessages().pins).toHaveLength(1)
    getDb().exec("DELETE FROM agent_sessions WHERE id='s1'")
    expect(listPinnedMessages().pins).toHaveLength(0)
    event('v', { content: 'remaining', sender: 'user' }, 's2', 'w1', 'user:message')
    createPinnedMessage({ workspaceId: 'w1', eventIds: ['v'] })
    getDb().exec("DELETE FROM workspaces WHERE id='w1'")
    expect(listPinnedMessages().pins).toHaveLength(0)
  })
  it('paginates lightweight metadata and deletes idempotently', () => {
    for (let i = 0; i < 3; i++) {
      event(`u${i}`, { content: `message ${i}`, sender: 'user' }, 's1', 'w1', 'user:message')
      createPinnedMessage({ workspaceId: 'w1', eventIds: [`u${i}`] })
    }
    const first = listPinnedMessages({ workspaceId: 'w1', limit: 2 })
    const second = listPinnedMessages({ workspaceId: 'w1', limit: 2, offset: 2 })
    expect(first.hasMore).toBe(true)
    expect(second.hasMore).toBe(false)
    expect(new Set([...first.pins, ...second.pins].map((p) => p.id)).size).toBe(3)
    expect(first.pins[0]).not.toHaveProperty('events')
    deletePinnedMessage(first.pins[0].id)
    deletePinnedMessage(first.pins[0].id)
    expect(listPinnedMessages().pins).toHaveLength(2)
  })
  it('rejects oversize selection/snapshot and invalid input without truncating', () => {
    event('big', { kind: 'message:text', messageId: 'm', text: 'x'.repeat(8 * 1024 * 1024) })
    for (const input of [
      null,
      {},
      { workspaceId: 'w1', eventIds: [] },
      { workspaceId: 'w1', eventIds: [1] },
      { workspaceId: 'w1', eventIds: ['a'], content: 'forged' },
      { workspaceId: 'w1', eventIds: Array(20001).fill('big') },
      { workspaceId: 'w1', eventIds: ['big'] },
    ])
      expect(() => createPinnedMessage(input)).toThrow()
    expect(listPinnedMessages().pins).toHaveLength(0)
  })
  it('completes only the selected session through interleaved rows and detects partial retention', () => {
    event('a', { kind: 'message:text', messageId: 'shared', text: 'first ' })
    event('foreign', { kind: 'message:text', messageId: 'shared', text: 'secret' }, 's3', 'w2')
    event('other', { kind: 'message:text', messageId: 'shared', text: 'other session' }, 's2')
    event('b', { kind: 'message:text', messageId: 'shared', text: 'last' })
    const pin = createPinnedMessage({ workspaceId: 'w1', eventIds: ['b'] })
    expect(getPinnedMessage(pin.id).events.map((e) => e.id)).toEqual(['a', 'b'])
    getDb().prepare('DELETE FROM ws_events WHERE id = ?').run('b')
    expect(getPinnedMessage(pin.id).pin.sourceAvailable).toBe(false)
    expect(getPinnedMessage(pin.id).events).toHaveLength(2)
  })

  it('supports a workspace without sessions and bounds pagination and plain-text preview', () => {
    getDb().exec("DELETE FROM agent_sessions WHERE workspace_id='w1'")
    event(
      'u',
      { content: '# Heading\n[Link](https://example.org) **bold**\n'.repeat(50), sender: 'user' },
      null,
      'w1',
      'user:message',
    )
    const pin = createPinnedMessage({ workspaceId: 'w1', sessionId: null, eventIds: ['u'] })
    expect(pin.sessionId).toBeNull()
    expect(pin.preview).toHaveLength(280)
    expect(pin.preview).not.toMatch(/[<#*`]/)
    for (const options of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 1.5 }, { limit: NaN }])
      expect(() => listPinnedMessages(options)).toThrow()
  })

  it('rejects an expanded logical message beyond the snapshot bound without partial persistence', () => {
    event('a', { kind: 'message:text', messageId: 'big', text: 'x'.repeat(5 * 1024 * 1024) })
    event('b', { kind: 'message:text', messageId: 'big', text: 'y'.repeat(4 * 1024 * 1024) })
    expect(() => createPinnedMessage({ workspaceId: 'w1', eventIds: ['b'] })).toThrow(/size limit/)
    expect(listPinnedMessages().pins).toHaveLength(0)
  })
})
