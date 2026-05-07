import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMigrations } from '../server/db/migrations.js'
import { initSchema } from '../server/db/schema.js'

// settings-service refuses to read settings in test mode without isolation.
// The /health endpoint reads global settings to surface integration config —
// stub the surface to a safe empty value.
vi.mock('../server/services/settings-service.js', () => ({
  getGlobalSettings: vi.fn(() => ({
    notionMcpKey: '',
    sentryMcpKey: '',
    editorCommand: '',
    worktreesPath: '',
    worktreesPrefixByProject: false,
  })),
  getProjectSettings: vi.fn(() => null),
  SETTINGS_SCHEMA_VERSION: 1,
}))

let tmpDir: string
let dbPath: string
let app: Hono

async function resetDb(): Promise<void> {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-routes-health-test-'))
  dbPath = path.join(tmpDir, 'test.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode=WAL')
  db.pragma('foreign_keys=ON')
  initSchema(db)
  // The /health endpoint reads schema_migrations to compute the current
  // schemaVersion. initSchema creates the data tables; runMigrations creates
  // the schema_migrations table itself and stamps the latest version.
  runMigrations(db)
  db.close()
}

describe('GET /api/health/report — active state', () => {
  beforeEach(async () => {
    await resetDb()
    const { getDb } = await import('../server/db/index.js')
    getDb(dbPath)
    const healthRouter = (await import('../server/routes/health.js')).default
    app = new Hono()
    app.route('/api/health', healthRouter)
  })

  afterEach(async () => {
    const { closeDb } = await import('../server/db/index.js')
    closeDb()
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('returns an `active` object with five empty arrays for an empty DB', async () => {
    const res = await app.request('/api/health/report')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { active: Record<string, unknown[]> }
    expect(body.active).toBeDefined()
    expect(body.active.quotaBackoffs).toEqual([])
    expect(body.active.pendingWakeups).toEqual([])
    expect(body.active.autoLoopActive).toEqual([])
    expect(body.active.agentSessionsAlive).toEqual([])
    expect(body.active.devServersRunning).toEqual([])
  })

  it('lists pending quota backoffs joined with workspace name, ordered by target_at', async () => {
    const { createWorkspace } = await import('../server/services/workspace-service.js')
    const w1 = createWorkspace({
      name: 'A',
      projectPath: '/tmp/p',
      sourceBranch: 'main',
      workingBranch: 'feature/a',
    })
    const w2 = createWorkspace({
      name: 'B',
      projectPath: '/tmp/p',
      sourceBranch: 'main',
      workingBranch: 'feature/b',
    })
    const { getDb } = await import('../server/db/index.js')
    const db = getDb()
    // Insert two backoffs — w2 fires sooner.
    db.prepare(
      `INSERT INTO pending_quota_backoffs (workspace_id, target_at, resets_at, source, retry_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(w1.id, '2026-05-07T10:00:00Z', null, 'fallback_ladder', 1, '2026-05-07T08:00:00Z')
    db.prepare(
      `INSERT INTO pending_quota_backoffs (workspace_id, target_at, resets_at, source, retry_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(w2.id, '2026-05-07T09:00:00Z', '2026-05-07T09:00:00Z', 'rate_limit_info', 0, '2026-05-07T08:00:00Z')

    const res = await app.request('/api/health/report')
    const body = (await res.json()) as { active: { quotaBackoffs: Array<{ workspaceId: string; name: string }> } }
    expect(body.active.quotaBackoffs).toHaveLength(2)
    expect(body.active.quotaBackoffs[0]).toMatchObject({ workspaceId: w2.id, name: 'B' })
    expect(body.active.quotaBackoffs[1]).toMatchObject({ workspaceId: w1.id, name: 'A' })
  })

  it('lists workspaces with auto_loop=1, ignoring archived ones', async () => {
    const { createWorkspace, archiveWorkspace } = await import('../server/services/workspace-service.js')
    const armed = createWorkspace({
      name: 'Armed',
      projectPath: '/tmp/p',
      sourceBranch: 'main',
      workingBranch: 'feature/armed',
    })
    const archived = createWorkspace({
      name: 'Archived',
      projectPath: '/tmp/p',
      sourceBranch: 'main',
      workingBranch: 'feature/arc',
    })
    const off = createWorkspace({
      name: 'Off',
      projectPath: '/tmp/p',
      sourceBranch: 'main',
      workingBranch: 'feature/off',
    })
    const { getDb } = await import('../server/db/index.js')
    const db = getDb()
    db.prepare('UPDATE workspaces SET auto_loop = 1, auto_loop_ready = 1 WHERE id = ?').run(armed.id)
    db.prepare('UPDATE workspaces SET auto_loop = 1, auto_loop_ready = 0 WHERE id = ?').run(archived.id)
    archiveWorkspace(archived.id)
    void off // off keeps auto_loop=0

    const res = await app.request('/api/health/report')
    const body = (await res.json()) as { active: { autoLoopActive: Array<{ name: string; ready: boolean }> } }
    expect(body.active.autoLoopActive).toHaveLength(1)
    expect(body.active.autoLoopActive[0]).toMatchObject({ name: 'Armed', ready: true })
  })

  it('lists running dev servers, ignoring archived workspaces', async () => {
    const { createWorkspace } = await import('../server/services/workspace-service.js')
    const live = createWorkspace({
      name: 'Live',
      projectPath: '/tmp/p',
      sourceBranch: 'main',
      workingBranch: 'feature/live',
    })
    const stopped = createWorkspace({
      name: 'Stopped',
      projectPath: '/tmp/p',
      sourceBranch: 'main',
      workingBranch: 'feature/stop',
    })
    const { getDb } = await import('../server/db/index.js')
    const db = getDb()
    db.prepare("UPDATE workspaces SET dev_server_status = 'running' WHERE id = ?").run(live.id)
    db.prepare("UPDATE workspaces SET dev_server_status = 'stopped' WHERE id = ?").run(stopped.id)

    const res = await app.request('/api/health/report')
    const body = (await res.json()) as { active: { devServersRunning: Array<{ name: string }> } }
    expect(body.active.devServersRunning).toHaveLength(1)
    expect(body.active.devServersRunning[0]?.name).toBe('Live')
  })
})
