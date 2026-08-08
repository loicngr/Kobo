import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initSchema } from '../server/db/schema.js'

// Real DB, real route — this endpoint (GET /:id/events) reads ws_events
// directly via getDb() and doesn't go through workspace-service, so we
// exercise it against a genuine in-memory-backed better-sqlite3 file rather
// than mocking the db layer (see workspace-service.test.ts for the same
// pattern).

let tmpDir: string
let dbPath: string
let workspaceId: string

async function resetDb() {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-ws-events-test-'))
  dbPath = path.join(tmpDir, 'test.db')

  const db = new Database(dbPath)
  db.pragma('journal_mode=WAL')
  db.pragma('foreign_keys=ON')
  initSchema(db)
  db.close()
}

/** Inserts a ws_events row, returning its generated id (so callers can use it as a cursor). */
function insertEvent(
  db: Database.Database,
  opts: { workspaceId: string; type?: string; sessionId?: string | null; createdAt?: string },
): string {
  const id = nanoid()
  db.prepare(
    'INSERT INTO ws_events (id, workspace_id, type, payload, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    opts.workspaceId,
    opts.type ?? 'agent:output',
    JSON.stringify({ text: 'hello' }),
    opts.sessionId ?? null,
    opts.createdAt ?? new Date().toISOString(),
  )
  return id
}

beforeEach(async () => {
  await resetDb()
  const { getDb } = await import('../server/db/index.js')
  const db = getDb(dbPath)

  workspaceId = nanoid()
  db.prepare(
    `INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, status, created_at, updated_at)
     VALUES (?, 'Test WS', '/tmp/test', 'main', 'feature/test', 'idle', datetime('now'), datetime('now'))`,
  ).run(workspaceId)
})

afterEach(async () => {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

async function getApp() {
  const mod = await import('../server/routes/workspaces.js')
  return mod.default
}

describe('GET /:id/events — around cursor hasMore', () => {
  it('returns hasMore: true for an "around" window without a session filter when older events exist', async () => {
    const { getDb } = await import('../server/db/index.js')
    const db = getDb()

    // 30 workspace-level events, no session — the deep-link scenario from
    // WorkspaceHistorySearch.vue, which only passes `session` when the
    // matched event actually has a sessionId.
    const ids: string[] = []
    for (let i = 0; i < 30; i++) {
      ids.push(insertEvent(db, { workspaceId }))
    }

    const app = await getApp()
    // Target a middle event with a small window so we know older events exist beyond it.
    const target = ids[15]
    const res = await app.request(`/${workspaceId}/events?around=${target}&limit=6`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: unknown[]; hasMore: boolean }

    expect(body.hasMore).toBe(true)
  })

  it('returns hasMore: false for an "around" window without a session filter when the window reaches the start of history', async () => {
    const { getDb } = await import('../server/db/index.js')
    const db = getDb()

    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      ids.push(insertEvent(db, { workspaceId }))
    }

    const app = await getApp()
    // Target the very first event with a window wide enough to cover the whole history.
    const target = ids[0]
    const res = await app.request(`/${workspaceId}/events?around=${target}&limit=100`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: unknown[]; hasMore: boolean }

    expect(body.hasMore).toBe(false)
  })

  it('returns hasMore: true for an "around" window scoped to a session when older session events exist', async () => {
    const { getDb } = await import('../server/db/index.js')
    const db = getDb()

    const sessionId = 'session-a'
    const ids: string[] = []
    for (let i = 0; i < 20; i++) {
      ids.push(insertEvent(db, { workspaceId, sessionId }))
    }

    const app = await getApp()
    const target = ids[10]
    const res = await app.request(`/${workspaceId}/events?around=${target}&session=${sessionId}&limit=6`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: unknown[]; hasMore: boolean }

    expect(body.hasMore).toBe(true)
  })
})

describe('GET /:id/events — pre-existing before / session behavior (regression)', () => {
  it('"before" cursor still returns hasMore: true when older events remain', async () => {
    const { getDb } = await import('../server/db/index.js')
    const db = getDb()

    const ids: string[] = []
    for (let i = 0; i < 10; i++) {
      ids.push(insertEvent(db, { workspaceId }))
    }

    const app = await getApp()
    const cursor = ids[8]
    const res = await app.request(`/${workspaceId}/events?before=${cursor}&limit=3`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: unknown[]; hasMore: boolean }

    expect(body.hasMore).toBe(true)
  })

  it('"before" cursor returns hasMore: false once the start of history is reached', async () => {
    const { getDb } = await import('../server/db/index.js')
    const db = getDb()

    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      ids.push(insertEvent(db, { workspaceId }))
    }

    const app = await getApp()
    const cursor = ids[2]
    const res = await app.request(`/${workspaceId}/events?before=${cursor}&limit=100`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: unknown[]; hasMore: boolean }

    expect(body.hasMore).toBe(false)
  })

  it('no-cursor + session returns hasMore based on total session count vs window size', async () => {
    const { getDb } = await import('../server/db/index.js')
    const db = getDb()

    const sessionId = 'session-b'
    for (let i = 0; i < 10; i++) {
      insertEvent(db, { workspaceId, sessionId })
    }

    const app = await getApp()
    const res = await app.request(`/${workspaceId}/events?session=${sessionId}&limit=4`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: unknown[]; hasMore: boolean }

    expect(body.hasMore).toBe(true)
  })

  it('no-cursor without a session returns the newest window and reports older history', async () => {
    const { getDb } = await import('../server/db/index.js')
    const db = getDb()
    const ids: string[] = []
    for (let i = 0; i < 10; i++) ids.push(insertEvent(db, { workspaceId }))

    const app = await getApp()
    const res = await app.request(`/${workspaceId}/events?limit=3`)
    const body = (await res.json()) as { events: Array<{ id: string }>; hasMore: boolean }

    expect(body.events.map((event) => event.id)).toEqual(ids.slice(-3))
    expect(body.hasMore).toBe(true)
  })

  it('clamps a negative limit instead of returning the complete history', async () => {
    const { getDb } = await import('../server/db/index.js')
    const db = getDb()
    for (let i = 0; i < 10; i++) insertEvent(db, { workspaceId })

    const app = await getApp()
    const res = await app.request(`/${workspaceId}/events?limit=-1`)
    const body = (await res.json()) as { events: unknown[] }
    expect(body.events).toHaveLength(1)
  })
})
