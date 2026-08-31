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

  it('drops executing, brainstorming and extracting workspaces back to idle on boot', async () => {
    const { createWorkspace, getWorkspace } = await import('../server/services/workspace-service.js')
    const orchestrator = await import('../server/services/agent/orchestrator.js')
    const { getDb } = await import('../server/db/index.js')
    const db = getDb()

    const ids: string[] = []
    for (const status of ['executing', 'brainstorming', 'extracting']) {
      const ws = createWorkspace({
        name: `Ghost ${status}`,
        projectPath: '/tmp/p',
        sourceBranch: 'main',
        workingBranch: `b-${status}`,
      })
      db.prepare('UPDATE workspaces SET status = ? WHERE id = ?').run(status, ws.id)
      ids.push(ws.id)
    }

    // The controller map is empty at boot by definition, so every one of these
    // is orphaned — no probe, no exception.
    orchestrator.reconcileOrphanSessions()

    for (const id of ids) {
      expect(getWorkspace(id)?.status).toBe('idle')
    }
  })

  it('drops an executing workspace back to idle on boot even when it is archived', async () => {
    // `archiveWorkspace` does not normalise the status, and unarchiving
    // restores the row as-is — an archived workspace stuck in `executing`
    // has no controller left to drive it, exactly like a non-archived one.
    const { createWorkspace, getWorkspace } = await import('../server/services/workspace-service.js')
    const orchestrator = await import('../server/services/agent/orchestrator.js')
    const { getDb } = await import('../server/db/index.js')
    const db = getDb()

    const ws = createWorkspace({
      name: 'Archived ghost',
      projectPath: '/tmp/p',
      sourceBranch: 'main',
      workingBranch: 'b-archived-ghost',
    })
    db.prepare("UPDATE workspaces SET status = 'executing', archived_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      ws.id,
    )

    orchestrator.reconcileOrphanSessions()

    expect(getWorkspace(ws.id)?.status).toBe('idle')
  })

  it('ends a running agent session even when its recorded pid is still alive', async () => {
    const { createWorkspace } = await import('../server/services/workspace-service.js')
    const orchestrator = await import('../server/services/agent/orchestrator.js')
    const { getDb } = await import('../server/db/index.js')
    const db = getDb()

    const ws = createWorkspace({
      name: 'Recycled pid',
      projectPath: '/tmp/p',
      sourceBranch: 'main',
      workingBranch: 'b-pid',
    })
    // `process.pid` is guaranteed alive — this is exactly the false positive a
    // machine restart produces when another program inherits the old pid.
    db.prepare(
      "INSERT INTO agent_sessions (id, workspace_id, pid, status, started_at) VALUES (?, ?, ?, 'running', ?)",
    ).run('sess-recycled', ws.id, process.pid, new Date().toISOString())

    orchestrator.reconcileOrphanSessions()

    expect(db.prepare('SELECT status FROM agent_sessions WHERE id = ?').get('sess-recycled')).toEqual({
      status: 'error',
    })
  })

  it('resets a running or starting dev_server_status to stopped on boot', async () => {
    const { createWorkspace, getWorkspace } = await import('../server/services/workspace-service.js')
    const orchestrator = await import('../server/services/agent/orchestrator.js')
    const { getDb } = await import('../server/db/index.js')
    const db = getDb()

    const running = createWorkspace({
      name: 'Dev running',
      projectPath: '/tmp/p',
      sourceBranch: 'main',
      workingBranch: 'b-dev-running',
    })
    const starting = createWorkspace({
      name: 'Dev starting',
      projectPath: '/tmp/p',
      sourceBranch: 'main',
      workingBranch: 'b-dev-starting',
    })
    db.prepare("UPDATE workspaces SET dev_server_status = 'running' WHERE id = ?").run(running.id)
    db.prepare("UPDATE workspaces SET dev_server_status = 'starting' WHERE id = ?").run(starting.id)

    orchestrator.reconcileOrphanSessions()

    expect(getWorkspace(running.id)?.devServerStatus).toBe('stopped')
    expect(getWorkspace(starting.id)?.devServerStatus).toBe('stopped')
  })
})
