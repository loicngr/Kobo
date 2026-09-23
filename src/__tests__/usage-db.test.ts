import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initSchema } from '../server/db/schema.js'

import { getAllPersistedSnapshots, upsertUsageSnapshot } from '../server/services/usage/db.js'
import type { UsageSnapshot } from '../server/services/usage/types.js'

let tmpDir: string
let dbPath: string

async function resetDb() {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-usage-db-test-'))
  dbPath = path.join(tmpDir, 'test.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode=WAL')
  db.pragma('foreign_keys=ON')
  initSchema(db)
  db.close()
}

const SAMPLE: UsageSnapshot = {
  providerId: 'claude-code',
  status: 'ok',
  buckets: [
    { id: 'five_hour', label: 'five_hour', usedPct: 23.4, resetsAt: '2026-04-29T18:00:00Z' },
    { id: 'seven_day', label: 'seven_day', usedPct: 67.2, resetsAt: '2026-05-04T12:00:00Z' },
  ],
  fetchedAt: '2026-04-29T14:30:00Z',
}

describe('usage-db helpers', () => {
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

  it('upserts a snapshot then reads it back', () => {
    upsertUsageSnapshot(SAMPLE)
    const all = getAllPersistedSnapshots()
    expect(all).toHaveLength(1)
    expect(all[0]).toEqual(SAMPLE)
  })

  it('upsert overwrites the existing row for the same provider', () => {
    upsertUsageSnapshot(SAMPLE)
    const updated: UsageSnapshot = { ...SAMPLE, fetchedAt: '2026-04-29T14:31:00Z', buckets: [] }
    upsertUsageSnapshot(updated)
    const all = getAllPersistedSnapshots()
    expect(all).toHaveLength(1)
    expect(all[0].fetchedAt).toBe('2026-04-29T14:31:00Z')
    expect(all[0].buckets).toEqual([])
  })

  it('round-trips status="error" with errorMessage', () => {
    const errSnap: UsageSnapshot = {
      providerId: 'claude-code',
      status: 'error',
      errorMessage: 'HTTP 401',
      buckets: [],
      fetchedAt: SAMPLE.fetchedAt,
    }
    upsertUsageSnapshot(errSnap)
    const all = getAllPersistedSnapshots()
    expect(all[0]).toEqual(errSnap)
  })

  it('returns empty array on a fresh DB', () => {
    expect(getAllPersistedSnapshots()).toEqual([])
  })
})
