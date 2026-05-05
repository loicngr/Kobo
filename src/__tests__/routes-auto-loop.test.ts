import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initSchema } from '../server/db/schema.js'

// Only mock what must NOT hit real infra (websocket, MCP, process spawn).
// We want the REAL workspace-service + auto-loop-service + HTTP routing.
vi.mock('../server/services/websocket-service.js', () => ({
  emit: vi.fn(),
  emitEphemeral: vi.fn(),
  handleConnection: vi.fn(),
  setMessageHandler: vi.fn(),
}))

vi.mock('../server/services/agent/orchestrator.js', () => ({
  startAgent: vi.fn(() => ({ agentSessionId: 'mock-agent-session-id' })),
  stopAgent: vi.fn(),
  sendMessage: vi.fn(),
  hasController: vi.fn(() => false),
  getAgentStatus: vi.fn(() => null),
  forgetRateLimitInfo: vi.fn(),
  forgetTasksDoneSnapshot: vi.fn(),
  interruptAgent: vi.fn(),
  startWatchdog: vi.fn(),
}))

vi.mock('../server/services/wakeup-service.js', () => ({
  schedule: vi.fn(),
  cancel: vi.fn(),
  rehydrate: vi.fn(),
  getPending: vi.fn(() => null),
}))

vi.mock('../server/services/pr-watcher-service.js', () => ({
  getAllPrStates: vi.fn(() => ({})),
  startPrWatcher: vi.fn(),
  stopPrWatcher: vi.fn(),
}))

// auto-loop-service reads both project and global settings in spawnNextIteration.
// The vitest guard in settings-service throws if `_setSettingsPath()` isn't
// called, so we mock the surface used by spawnNextIteration. Returning
// undefined / empty defaults makes the settings fall back to safe values.
vi.mock('../server/services/settings-service.js', () => ({
  getProjectSettings: vi.fn(),
  getGlobalSettings: vi.fn(() => ({
    worktreesPath: '',
    worktreesPrefixByProject: false,
  })),
}))

let tmpDir: string
let dbPath: string
let app: Hono
let wsId: string

async function resetDb() {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-routes-autoloop-'))
  dbPath = path.join(tmpDir, 'test.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode=WAL')
  db.pragma('foreign_keys=ON')
  initSchema(db)
  db.close()
}

beforeEach(async () => {
  await resetDb()
  const { getDb } = await import('../server/db/index.js')
  getDb(dbPath)

  // Create a workspace with a real on-disk worktree so spawnNextIteration
  // doesn't trip the fs.existsSync guard in auto-loop-service.
  const worktreesDir = path.join(tmpDir, '.worktrees', 'feature', 'x')
  fs.mkdirSync(worktreesDir, { recursive: true })

  const { createWorkspace } = await import('../server/services/workspace-service.js')
  const ws = createWorkspace({
    name: 'w',
    projectPath: tmpDir,
    sourceBranch: 'main',
    workingBranch: 'feature/x',
  })
  wsId = ws.id

  const workspacesRouter = (await import('../server/routes/workspaces.js')).default
  app = new Hono()
  app.route('/api/workspaces', workspacesRouter)

  // Clear call history + restore vanilla vi.fn() behaviour so an earlier
  // test that changed a mock's implementation (e.g. `startAgent` to throw)
  // doesn't leak into the next test.
  vi.clearAllMocks()
  const orch = await import('../server/services/agent/orchestrator.js')
  ;(orch.startAgent as ReturnType<typeof vi.fn>).mockReset()
  ;(orch.hasController as ReturnType<typeof vi.fn>).mockReset().mockReturnValue(false)
})

afterEach(async () => {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('GET /api/workspaces/:id/auto-loop', () => {
  it('returns the default status for a fresh workspace', async () => {
    const res = await app.request(`/api/workspaces/${wsId}/auto-loop`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      auto_loop: false,
      auto_loop_ready: false,
      no_progress_streak: 0,
    })
  })
})

describe('GET /api/workspaces/auto-loop-states', () => {
  it('returns a batch snapshot keyed by workspace id', async () => {
    const res = await app.request('/api/workspaces/auto-loop-states')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body[wsId]).toEqual({
      auto_loop: false,
      auto_loop_ready: false,
      no_progress_streak: 0,
    })
  })

  it('is not matched by GET /:id (route order regression)', async () => {
    const res = await app.request('/api/workspaces/auto-loop-states')
    expect(res.status).toBe(200)
    // If the /:id handler had captured this request, the shape would
    // be a single workspace object, not a Record keyed by id.
    const body = await res.json()
    expect(body).not.toHaveProperty('id')
    expect(body).not.toHaveProperty('name')
  })
})

describe('POST /api/workspaces/:id/auto-loop', () => {
  it('returns 400 when auto_loop_ready is false', async () => {
    const res = await app.request(`/api/workspaces/${wsId}/auto-loop`, { method: 'POST' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/not ready/i)
  })

  it('enables the loop when ready + returns 200', async () => {
    const { setAutoLoopReady, createTask } = await import('../server/services/workspace-service.js')
    setAutoLoopReady(wsId, true)
    createTask(wsId, { title: 't1', isAcceptanceCriterion: false, sortOrder: 0 })

    const res = await app.request(`/api/workspaces/${wsId}/auto-loop`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    const statusRes = await app.request(`/api/workspaces/${wsId}/auto-loop`)
    const status = await statusRes.json()
    expect(status).toMatchObject({ auto_loop: true, auto_loop_ready: true })
  })

  it('returns 400 + auto-disables when startAgent throws on the initial spawn', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    ;(orch.startAgent as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('boom')
    })
    const { setAutoLoopReady, createTask } = await import('../server/services/workspace-service.js')
    setAutoLoopReady(wsId, true)
    createTask(wsId, { title: 't1', isAcceptanceCriterion: false, sortOrder: 0 })

    const res = await app.request(`/api/workspaces/${wsId}/auto-loop`, { method: 'POST' })
    expect(res.status).toBe(400)

    const statusRes = await app.request(`/api/workspaces/${wsId}/auto-loop`)
    const status = await statusRes.json()
    expect(status).toMatchObject({ auto_loop: false })
  })
})

describe('DELETE /api/workspaces/:id/auto-loop', () => {
  it('disables the loop + returns 200', async () => {
    const { setAutoLoopReady, createTask } = await import('../server/services/workspace-service.js')
    setAutoLoopReady(wsId, true)
    createTask(wsId, { title: 't1', isAcceptanceCriterion: false, sortOrder: 0 })
    await app.request(`/api/workspaces/${wsId}/auto-loop`, { method: 'POST' })

    const res = await app.request(`/api/workspaces/${wsId}/auto-loop`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    const statusRes = await app.request(`/api/workspaces/${wsId}/auto-loop`)
    const status = await statusRes.json()
    expect(status).toMatchObject({ auto_loop: false })
  })

  it('is idempotent on a non-running workspace', async () => {
    const res = await app.request(`/api/workspaces/${wsId}/auto-loop`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('POST /api/workspaces/:id/auto-loop-ready', () => {
  it('flips the ready flag and emits autoloop:ready-flipped', async () => {
    const ws = await import('../server/services/websocket-service.js')

    const res = await app.request(`/api/workspaces/${wsId}/auto-loop-ready`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    const statusRes = await app.request(`/api/workspaces/${wsId}/auto-loop`)
    const status = await statusRes.json()
    expect(status).toMatchObject({ auto_loop_ready: true })

    expect(ws.emitEphemeral).toHaveBeenCalledWith(wsId, 'autoloop:ready-flipped', {})
  })

  it('returns 404 for unknown workspace', async () => {
    const res = await app.request('/api/workspaces/nope/auto-loop-ready', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('spawns first auto-loop iteration when workspace is armed (auto_loop=1) and tasks exist', async () => {
    const { createTask } = await import('../server/services/workspace-service.js')
    const { startAgent } = await import('../server/services/agent/orchestrator.js')
    const db = (await import('../server/db/index.js')).getDb()

    // Simulate creation-time autoLoop=true flag (armed, not yet ready)
    db.prepare('UPDATE workspaces SET auto_loop = 1, auto_loop_ready = 0 WHERE id = ?').run(wsId)
    createTask(wsId, { title: 'implement feature', isAcceptanceCriterion: false, sortOrder: 0 })
    ;(startAgent as ReturnType<typeof vi.fn>).mockClear()

    const res = await app.request(`/api/workspaces/${wsId}/auto-loop-ready`, { method: 'POST' })
    expect(res.status).toBe(200)

    expect(startAgent).toHaveBeenCalled()
  })

  it('does not spawn when workspace is armed but has no pending tasks', async () => {
    const { startAgent } = await import('../server/services/agent/orchestrator.js')
    const db = (await import('../server/db/index.js')).getDb()

    db.prepare('UPDATE workspaces SET auto_loop = 1, auto_loop_ready = 0 WHERE id = ?').run(wsId)
    ;(startAgent as ReturnType<typeof vi.fn>).mockClear()

    const res = await app.request(`/api/workspaces/${wsId}/auto-loop-ready`, { method: 'POST' })
    expect(res.status).toBe(200)

    expect(startAgent).not.toHaveBeenCalled()
  })
})

describe('archive auto-disables auto-loop', () => {
  it('archiving a running-loop workspace flips auto_loop to 0', async () => {
    const { setAutoLoopReady, createTask, archiveWorkspace } = await import('../server/services/workspace-service.js')
    setAutoLoopReady(wsId, true)
    createTask(wsId, { title: 't1', isAcceptanceCriterion: false, sortOrder: 0 })
    await app.request(`/api/workspaces/${wsId}/auto-loop`, { method: 'POST' })

    // Pre-condition check: loop is on.
    let statusRes = await app.request(`/api/workspaces/${wsId}/auto-loop`)
    let status = await statusRes.json()
    expect(status).toMatchObject({ auto_loop: true })

    archiveWorkspace(wsId)

    statusRes = await app.request(`/api/workspaces/${wsId}/auto-loop`)
    status = await statusRes.json()
    expect(status).toMatchObject({ auto_loop: false })
  })
})

describe('GET /api/workspaces/:id/events with session filter', () => {
  it('includes workspace-level rows without session_id in a session-scoped fetch', async () => {
    const db = (await import('../server/db/index.js')).getDb()
    db.prepare(
      "INSERT INTO ws_events (id, workspace_id, type, payload, session_id, created_at) VALUES (?, ?, 'user:message', ?, NULL, ?)",
    ).run('evt-ws', wsId, JSON.stringify({ content: 'workspace note', sender: 'user' }), '2026-01-01T00:00:01Z')
    db.prepare(
      "INSERT INTO ws_events (id, workspace_id, type, payload, session_id, created_at) VALUES (?, ?, 'agent:event', ?, ?, ?)",
    ).run(
      'evt-s1',
      wsId,
      JSON.stringify({ kind: 'message:raw', content: 'session one' }),
      'sess-1',
      '2026-01-01T00:00:02Z',
    )

    const res = await app.request(`/api/workspaces/${wsId}/events?session=sess-1&limit=10`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: Array<{ id: string; sessionId: string | null }>; hasMore: boolean }
    expect(body.events.map((e) => [e.id, e.sessionId])).toEqual([
      ['evt-ws', null],
      ['evt-s1', 'sess-1'],
    ])
  })

  it('returns hasMore=true on the first page when a session has more rows than limit', async () => {
    const db = (await import('../server/db/index.js')).getDb()
    db.prepare(
      "INSERT INTO ws_events (id, workspace_id, type, payload, session_id, created_at) VALUES (?, ?, 'agent:event', ?, ?, ?)",
    ).run('evt-1', wsId, JSON.stringify({ kind: 'message:raw', content: 'one' }), 'sess-1', '2026-01-01T00:00:01Z')
    db.prepare(
      "INSERT INTO ws_events (id, workspace_id, type, payload, session_id, created_at) VALUES (?, ?, 'agent:event', ?, ?, ?)",
    ).run('evt-2', wsId, JSON.stringify({ kind: 'message:raw', content: 'two' }), 'sess-1', '2026-01-01T00:00:02Z')
    db.prepare(
      "INSERT INTO ws_events (id, workspace_id, type, payload, session_id, created_at) VALUES (?, ?, 'agent:event', ?, ?, ?)",
    ).run('evt-3', wsId, JSON.stringify({ kind: 'message:raw', content: 'three' }), 'sess-1', '2026-01-01T00:00:03Z')

    const res = await app.request(`/api/workspaces/${wsId}/events?session=sess-1&limit=2`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: Array<{ id: string }>; hasMore: boolean }
    expect(body.events.map((e) => e.id)).toEqual(['evt-2', 'evt-3'])
    expect(body.hasMore).toBe(true)
  })

  it('does not count older rows from another session when computing hasMore', async () => {
    const db = (await import('../server/db/index.js')).getDb()
    db.prepare(
      "INSERT INTO ws_events (id, workspace_id, type, payload, session_id, created_at) VALUES (?, ?, 'agent:event', ?, ?, ?)",
    ).run(
      'evt-other',
      wsId,
      JSON.stringify({ kind: 'message:raw', content: 'other' }),
      'sess-2',
      '2026-01-01T00:00:01Z',
    )
    db.prepare(
      "INSERT INTO ws_events (id, workspace_id, type, payload, session_id, created_at) VALUES (?, ?, 'agent:event', ?, ?, ?)",
    ).run('evt-a', wsId, JSON.stringify({ kind: 'message:raw', content: 'a' }), 'sess-1', '2026-01-01T00:00:02Z')
    db.prepare(
      "INSERT INTO ws_events (id, workspace_id, type, payload, session_id, created_at) VALUES (?, ?, 'agent:event', ?, ?, ?)",
    ).run('evt-b', wsId, JSON.stringify({ kind: 'message:raw', content: 'b' }), 'sess-1', '2026-01-01T00:00:03Z')

    const res = await app.request(`/api/workspaces/${wsId}/events?session=sess-1&before=evt-b&limit=1`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: Array<{ id: string }>; hasMore: boolean }
    expect(body.events.map((e) => e.id)).toEqual(['evt-a'])
    expect(body.hasMore).toBe(false)
  })

  it('counts older workspace-level rows when computing hasMore for a session view', async () => {
    const db = (await import('../server/db/index.js')).getDb()
    db.prepare(
      "INSERT INTO ws_events (id, workspace_id, type, payload, session_id, created_at) VALUES (?, ?, 'user:message', ?, NULL, ?)",
    ).run('evt-ws-old', wsId, JSON.stringify({ content: 'workspace old', sender: 'user' }), '2026-01-01T00:00:01Z')
    db.prepare(
      "INSERT INTO ws_events (id, workspace_id, type, payload, session_id, created_at) VALUES (?, ?, 'agent:event', ?, ?, ?)",
    ).run(
      'evt-s1-a',
      wsId,
      JSON.stringify({ kind: 'message:raw', content: 'session a' }),
      'sess-1',
      '2026-01-01T00:00:02Z',
    )
    db.prepare(
      "INSERT INTO ws_events (id, workspace_id, type, payload, session_id, created_at) VALUES (?, ?, 'agent:event', ?, ?, ?)",
    ).run(
      'evt-s1-b',
      wsId,
      JSON.stringify({ kind: 'message:raw', content: 'session b' }),
      'sess-1',
      '2026-01-01T00:00:03Z',
    )

    const res = await app.request(`/api/workspaces/${wsId}/events?session=sess-1&before=evt-s1-a&limit=1`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: Array<{ id: string }>; hasMore: boolean }
    expect(body.events.map((e) => e.id)).toEqual(['evt-ws-old'])
    expect(body.hasMore).toBe(false)
  })
})
