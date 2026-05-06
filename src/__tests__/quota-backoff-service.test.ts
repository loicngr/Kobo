import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initSchema } from '../server/db/schema.js'

// Mock the websocket-service so tests don't open sockets.
vi.mock('../server/services/websocket-service.js', () => ({
  emit: vi.fn(),
  emitEphemeral: vi.fn(),
}))

let tmpDir: string
let dbPath: string

async function resetDb() {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-quota-backoff-test-'))
  dbPath = path.join(tmpDir, 'test.db')

  const db = new Database(dbPath)
  db.pragma('journal_mode=WAL')
  db.pragma('foreign_keys=ON')
  initSchema(db)
  db.close()
}

async function makeWorkspace(name = 'w'): Promise<string> {
  const { createWorkspace } = await import('../server/services/workspace-service.js')
  const ws = createWorkspace({
    name,
    projectPath: '/tmp/proj',
    sourceBranch: 'main',
    workingBranch: 'feature/x',
  })
  return ws.id
}

async function rawInsert(
  workspaceId: string,
  targetAt: string,
  resetsAt: string | null,
  source: string,
  retryCount: number,
): Promise<void> {
  const { getDb } = await import('../server/db/index.js')
  const db = getDb()
  db.prepare(
    `INSERT INTO pending_quota_backoffs (workspace_id, target_at, resets_at, source, retry_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(workspaceId, targetAt, resetsAt, source, retryCount, new Date().toISOString())
}

describe('quota-backoff-service', () => {
  beforeEach(async () => {
    await resetDb()
    const { getDb } = await import('../server/db/index.js')
    getDb(dbPath)
    vi.useFakeTimers({ shouldAdvanceTime: false })
    vi.setSystemTime(new Date('2026-05-06T10:00:00Z'))
    vi.clearAllMocks()
  })

  afterEach(async () => {
    vi.useRealTimers()
    const { closeDb } = await import('../server/db/index.js')
    closeDb()
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('arm() inserts a row and getPending() reads it back', async () => {
    const wsId = await makeWorkspace()
    const service = await import('../server/services/quota-backoff-service.js')

    service.arm(wsId, 60_000, { resetsAt: '2026-05-06T13:30:00Z', source: 'usage_api' })
    const pending = service.getPending(wsId)

    expect(pending).toBeDefined()
    expect(pending?.resetsAt).toBe('2026-05-06T13:30:00Z')
    expect(pending?.source).toBe('usage_api')
    expect(pending?.retryCount).toBe(1)
  })

  it('arm() overwrites an existing row and bumps retry_count', async () => {
    const wsId = await makeWorkspace()
    const service = await import('../server/services/quota-backoff-service.js')

    service.arm(wsId, 60_000, { resetsAt: null, source: 'fallback_ladder' })
    service.arm(wsId, 30_000, { resetsAt: null, source: 'fallback_ladder' })
    const pending = service.getPending(wsId)

    expect(pending?.retryCount).toBe(2)
  })

  it('cancel() deletes the row and clears the timer, returns true when a row existed', async () => {
    const wsId = await makeWorkspace()
    const service = await import('../server/services/quota-backoff-service.js')

    service.arm(wsId, 60_000, { resetsAt: null, source: 'fallback_ladder' })
    expect(service.cancel(wsId, 'user')).toBe(true)
    expect(service.getPending(wsId)).toBeNull()
  })

  it('cancel() returns false on unknown workspace', async () => {
    const service = await import('../server/services/quota-backoff-service.js')
    expect(service.cancel('does-not-exist', 'user')).toBe(false)
  })

  it('listPending() returns all rows', async () => {
    const w1 = await makeWorkspace('w1')
    const w2 = await makeWorkspace('w2')
    const service = await import('../server/services/quota-backoff-service.js')

    service.arm(w1, 60_000, { resetsAt: null, source: 'fallback_ladder' })
    service.arm(w2, 60_000, { resetsAt: null, source: 'fallback_ladder' })

    expect(service.listPending().length).toBe(2)
  })

  it('restoreOnBoot() arms a future row, fires it after the delay', async () => {
    const wsId = await makeWorkspace()
    const service = await import('../server/services/quota-backoff-service.js')

    const future = new Date(Date.now() + 60_000).toISOString()
    await rawInsert(wsId, future, null, 'fallback_ladder', 0)
    const fired = vi.fn()
    service.restoreOnBoot(fired)

    expect(fired).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_001)
    expect(fired).toHaveBeenCalledWith(wsId)
  })

  it('restoreOnBoot() fires immediately when target_at is in the past', async () => {
    const wsId = await makeWorkspace()
    const service = await import('../server/services/quota-backoff-service.js')

    const past = new Date(Date.now() - 60_000).toISOString()
    await rawInsert(wsId, past, null, 'fallback_ladder', 0)
    const fired = vi.fn()
    service.restoreOnBoot(fired)
    await vi.advanceTimersByTimeAsync(0)

    expect(fired).toHaveBeenCalledWith(wsId)
  })

  it('restoreOnBoot() skips and deletes rows for archived workspaces', async () => {
    const wsId = await makeWorkspace()
    const { archiveWorkspace } = await import('../server/services/workspace-service.js')
    archiveWorkspace(wsId)

    const service = await import('../server/services/quota-backoff-service.js')
    await rawInsert(wsId, new Date(Date.now() + 60_000).toISOString(), null, 'fallback_ladder', 0)
    const fired = vi.fn()
    service.restoreOnBoot(fired)
    await vi.advanceTimersByTimeAsync(60_001)

    expect(fired).not.toHaveBeenCalled()
    expect(service.getPending(wsId)).toBeNull()
  })

  it('cancel(reason) emits agent:quota-backoff-cancelled with the reason', async () => {
    const wsId = await makeWorkspace()
    const service = await import('../server/services/quota-backoff-service.js')
    const ws = await import('../server/services/websocket-service.js')

    service.arm(wsId, 60_000, { resetsAt: null, source: 'fallback_ladder' })
    service.cancel(wsId, 'user')

    const cancelled = (ws.emitEphemeral as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, type]) => type === 'agent:quota-backoff-cancelled',
    )
    expect(cancelled).toBeDefined()
    expect(cancelled![2]).toMatchObject({ reason: 'user' })
  })

  it('fireOrSkip() consumes the persisted DB row before invoking the callback (no double-fire on restart)', async () => {
    // Without the DB delete in fireOrSkip, a server crash between fire and
    // session_end would leave the row in place; restoreOnBoot would re-arm
    // a timer with target_at in the past and double-spawn on next start.
    const wsId = await makeWorkspace()
    const service = await import('../server/services/quota-backoff-service.js')

    const fired = vi.fn()
    service.setOnFireCallback(fired)
    service.arm(wsId, 60_000, { resetsAt: null, source: 'fallback_ladder' })
    expect(service.getPending(wsId)).not.toBeNull()

    await vi.advanceTimersByTimeAsync(60_001)

    expect(fired).toHaveBeenCalledWith(wsId)
    expect(service.getPending(wsId)).toBeNull()
  })

  it('cancel() accepts the deleted reason and emits it', async () => {
    const wsId = await makeWorkspace()
    const service = await import('../server/services/quota-backoff-service.js')
    const ws = await import('../server/services/websocket-service.js')

    service.arm(wsId, 60_000, { resetsAt: null, source: 'fallback_ladder' })
    service.cancel(wsId, 'deleted')

    const cancelled = (ws.emitEphemeral as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, type]) => type === 'agent:quota-backoff-cancelled',
    )
    expect(cancelled).toBeDefined()
    expect(cancelled![2]).toMatchObject({ reason: 'deleted' })
  })
})
