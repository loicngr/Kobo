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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-reconcile-'))
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

describe('reconcileOrphanSessions', () => {
  it('drops awaiting-user workspaces back to idle on boot', async () => {
    const { createWorkspace, getWorkspace } = await import('../server/services/workspace-service.js')
    const orchestrator = await import('../server/services/agent/orchestrator.js')
    const { getDb } = await import('../server/db/index.js')

    const ws = createWorkspace({
      name: 'Stuck',
      projectPath: '/tmp/p',
      sourceBranch: 'main',
      workingBranch: 'b-stuck',
    })
    // Force the workspace into `awaiting-user` directly — simulates what we'd
    // see after a server kill with a turn paused on canUseTool.
    getDb().prepare("UPDATE workspaces SET status = 'awaiting-user' WHERE id = ?").run(ws.id)
    expect(getWorkspace(ws.id)?.status).toBe('awaiting-user')

    orchestrator.reconcileOrphanSessions()

    expect(getWorkspace(ws.id)?.status).toBe('idle')
  })
})
