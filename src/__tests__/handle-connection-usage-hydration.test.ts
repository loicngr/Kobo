import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initSchema } from '../server/db/schema.js'
import { upsertUsageSnapshot } from '../server/services/usage/db.js'
import type { UsageSnapshot } from '../server/services/usage/types.js'
import { handleConnection } from '../server/services/websocket-service.js'

let tmpDir: string
let dbPath: string

async function resetDb() {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-ws-hydration-test-'))
  dbPath = path.join(tmpDir, 'test.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode=WAL')
  db.pragma('foreign_keys=ON')
  initSchema(db)
  db.close()
}

class FakeWs {
  readyState = 1
  sent: string[] = []
  send(msg: string) {
    this.sent.push(msg)
  }
  on() {
    /* noop */
  }
  ping() {
    /* noop */
  }
}

describe('handleConnection — usage:snapshot cold-start hydration', () => {
  beforeEach(async () => {
    await resetDb()
    const { getDb } = await import('../server/db/index.js')
    getDb(dbPath)
  })
  afterEach(async () => {
    const { closeDb } = await import('../server/db/index.js')
    closeDb()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('pushes one usage:snapshot per persisted provider on connect', () => {
    const snap: UsageSnapshot = {
      providerId: 'claude-code',
      status: 'ok',
      buckets: [{ id: 'five_hour', label: 'five_hour', usedPct: 12, resetsAt: '2026-04-29T18:00:00Z' }],
      fetchedAt: '2026-04-29T14:30:00Z',
    }
    upsertUsageSnapshot(snap)

    const ws = new FakeWs()
    handleConnection(ws as never)

    const usageMessages = ws.sent
      .map((m) => JSON.parse(m) as { type: string; payload: unknown })
      .filter((m) => m.type === 'usage:snapshot')

    expect(usageMessages).toHaveLength(1)
    expect(usageMessages[0].payload).toEqual({ providerId: 'claude-code', snapshot: snap })
  })

  it('sends nothing of type usage:snapshot when no row exists', () => {
    const ws = new FakeWs()
    handleConnection(ws as never)
    const usageMessages = ws.sent
      .map((m) => JSON.parse(m) as { type: string })
      .filter((m) => m.type === 'usage:snapshot')
    expect(usageMessages).toHaveLength(0)
  })
})
