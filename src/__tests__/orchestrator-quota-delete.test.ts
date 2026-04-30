import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initSchema } from '../server/db/schema.js'

vi.mock('../server/services/websocket-service.js', () => ({
  emit: vi.fn(),
  emitEphemeral: vi.fn(),
}))

vi.mock('../server/services/wakeup-service.js', () => ({
  schedule: vi.fn(),
  cancel: vi.fn(),
  rehydrate: vi.fn(),
  getPending: vi.fn(() => null),
}))

let tmpDir: string
let dbPath: string

beforeEach(async () => {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-quota-del-'))
  dbPath = path.join(tmpDir, 'test.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode=WAL')
  db.pragma('foreign_keys=ON')
  initSchema(db)
  db.close()
  const { getDb } = await import('../server/db/index.js')
  getDb(dbPath)
})

afterEach(async () => {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

describe('deleteWorkspace clears rate_limit cache', () => {
  it('forgets the entry so subsequent computeQuotaBackoffMs falls back', async () => {
    const { createWorkspace, deleteWorkspace } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'w',
      projectPath: '/tmp/p',
      sourceBranch: 'main',
      workingBranch: 'feature/x',
    })

    const orch = await import('../server/services/agent/orchestrator.js')
    // resetsAt must be in the future and within 24h for the info path to
    // win over the exponential fallback (sanity bound in the helper).
    const resetsAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()
    orch._test_setRateLimitInfo(ws.id, {
      buckets: [{ id: 'x', usedPct: 100, resetsAt }],
    })
    expect(orch.computeQuotaBackoffMs(ws.id, 0).source).toBe('rate_limit_info')

    deleteWorkspace(ws.id)

    expect(orch.computeQuotaBackoffMs(ws.id, 0).source).toBe('exponential_fallback')
  })
})
