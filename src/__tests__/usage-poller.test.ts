import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initSchema } from '../server/db/schema.js'
import { getAllPersistedSnapshots } from '../server/services/usage/db.js'
import { _setProvidersForTest, refreshNow, startUsagePoller, stopUsagePoller } from '../server/services/usage/poller.js'
import type { UsageProvider, UsageSnapshot } from '../server/services/usage/types.js'

vi.mock('../server/services/websocket-service.js', () => ({
  broadcastAll: vi.fn(),
}))

import { broadcastAll } from '../server/services/websocket-service.js'

let tmpDir: string
let dbPath: string

async function resetDb() {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-usage-poller-test-'))
  dbPath = path.join(tmpDir, 'test.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode=WAL')
  db.pragma('foreign_keys=ON')
  initSchema(db)
  db.close()
}

function makeFakeProvider(opts?: Partial<UsageProvider>): UsageProvider {
  return {
    id: 'claude-code',
    displayName: 'Claude Code (fake)',
    isAvailable: vi.fn(async () => true),
    fetchSnapshot: vi.fn(
      async (): Promise<UsageSnapshot> => ({
        providerId: 'claude-code',
        status: 'ok',
        buckets: [],
        fetchedAt: '2026-04-29T14:30:00Z',
      }),
    ),
    ...opts,
  }
}

describe('usage poller', () => {
  beforeEach(async () => {
    await resetDb()
    const { getDb } = await import('../server/db/index.js')
    getDb(dbPath)
    vi.useFakeTimers()
    vi.mocked(broadcastAll).mockClear()
  })

  afterEach(async () => {
    stopUsagePoller()
    vi.useRealTimers()
    vi.restoreAllMocks()
    _setProvidersForTest(null)
    const { closeDb } = await import('../server/db/index.js')
    closeDb()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('runs the first tick immediately on start', async () => {
    const provider = makeFakeProvider()
    _setProvidersForTest([provider])
    startUsagePoller()
    // Drain the microtask queue from the immediate `void tick()`.
    // Multiple `await`s are needed because the inner code chains
    // `await isAvailable()` then `await fetchSnapshot()` then synchronous
    // persistAndBroadcast. Two awaits is enough for the spy to register.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(provider.fetchSnapshot).toHaveBeenCalledTimes(1)
  })

  it('runs another tick every POLL_INTERVAL_MS', async () => {
    const provider = makeFakeProvider()
    _setProvidersForTest([provider])
    startUsagePoller()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(provider.fetchSnapshot).toHaveBeenCalledTimes(1) // immediate tick
    await vi.advanceTimersByTimeAsync(60_000)
    expect(provider.fetchSnapshot).toHaveBeenCalledTimes(2) // + first interval tick
    await vi.advanceTimersByTimeAsync(60_000)
    expect(provider.fetchSnapshot).toHaveBeenCalledTimes(3) // + second interval tick
  })

  it('skips providers that are not available', async () => {
    const offline = makeFakeProvider({ isAvailable: vi.fn(async () => false) })
    _setProvidersForTest([offline])
    startUsagePoller()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(offline.fetchSnapshot).not.toHaveBeenCalled()
  })

  it('persists each tick result to DB', async () => {
    _setProvidersForTest([makeFakeProvider()])
    startUsagePoller()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(getAllPersistedSnapshots()).toHaveLength(1)
  })

  it('broadcasts each tick result via broadcastAll', async () => {
    _setProvidersForTest([makeFakeProvider()])
    startUsagePoller()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(broadcastAll).toHaveBeenCalledWith(
      'usage:snapshot',
      expect.objectContaining({
        providerId: 'claude-code',
        snapshot: expect.objectContaining({ status: 'ok' }),
      }),
    )
  })

  it('stopUsagePoller cancels the schedule', async () => {
    const provider = makeFakeProvider()
    _setProvidersForTest([provider])
    startUsagePoller()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(provider.fetchSnapshot).toHaveBeenCalledTimes(1) // immediate tick happened
    stopUsagePoller()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(provider.fetchSnapshot).toHaveBeenCalledTimes(1) // stop cancelled the interval — no more ticks
  })

  it('refreshNow forces a fetch even when isAvailable would say false', async () => {
    const offline = makeFakeProvider({ isAvailable: vi.fn(async () => false) })
    _setProvidersForTest([offline])
    const snap = await refreshNow('claude-code')
    expect(offline.fetchSnapshot).toHaveBeenCalledTimes(1)
    expect(snap?.providerId).toBe('claude-code')
    expect(broadcastAll).toHaveBeenCalledTimes(1)
  })

  it('refreshNow returns null for an unknown provider id', async () => {
    _setProvidersForTest([makeFakeProvider()])
    // @ts-expect-error testing runtime guard with an invalid id
    const snap = await refreshNow('codex')
    expect(snap).toBeNull()
  })
})
