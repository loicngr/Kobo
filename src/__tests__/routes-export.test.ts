import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initSchema } from '../server/db/schema.js'

let tmpDir: string
let dbPath: string
let app: Hono
let wsId: string

async function resetDb() {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-export-test-'))
  dbPath = path.join(tmpDir, 'test.db')
  const seed = new Database(dbPath)
  seed.pragma('journal_mode=WAL')
  seed.pragma('foreign_keys=ON')
  initSchema(seed)
  seed.close()
}

function insertEvent(type: string, payload: unknown, sessionId: string, createdAt: string, id: string) {
  return import('../server/db/index.js').then(({ getDb }) => {
    getDb()
      .prepare(
        'INSERT INTO ws_events (id, workspace_id, type, payload, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, wsId, type, JSON.stringify(payload), sessionId, createdAt)
  })
}

beforeEach(async () => {
  await resetDb()
  const { getDb } = await import('../server/db/index.js')
  getDb(dbPath)
  const { createWorkspace } = await import('../server/services/workspace-service.js')
  wsId = createWorkspace({
    name: 'Test Workspace',
    projectPath: '/tmp/proj',
    sourceBranch: 'main',
    workingBranch: 'feature/x',
    worktreePath: path.join(tmpDir, 'wt'),
  }).id

  const exportRouter = (await import('../server/routes/export.js')).default
  app = new Hono()
  app.route('/api/workspaces', exportRouter)
})

afterEach(async () => {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('GET /api/workspaces/:id/events.csv', () => {
  it('returns 404 for an unknown workspace', async () => {
    const res = await app.request('/api/workspaces/nope/events.csv')
    expect(res.status).toBe(404)
  })

  it('exports events as CSV: header, chronological order, extracted text column', async () => {
    await insertEvent('user:message', { content: 'hello' }, 'sess-1', '2026-05-15T10:00:00Z', 'e1')
    await insertEvent('agent:status', { status: 'idle' }, 'sess-1', '2026-05-15T10:01:00Z', 'e2')

    const res = await app.request(`/api/workspaces/${wsId}/events.csv`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/csv')
    expect(res.headers.get('Content-Disposition')).toContain('test-workspace-events.csv')

    const body = (await res.text()).replace(/^﻿/, '')
    const lines = body.trim().split('\r\n')
    expect(lines[0]).toBe('created_at,session_id,type,text,payload')
    // Chronological (rowid ASC) — e1 before e2.
    expect(lines[1]).toContain('user:message')
    expect(lines[1]).toContain('hello') // text column extracted from payload.content
    expect(lines[2]).toContain('agent:status')
    expect(lines).toHaveLength(3)
  })

  it('escapes commas, quotes and newlines in cell values', async () => {
    await insertEvent('user:message', { content: 'a, "b"\nc' }, 'sess-1', '2026-05-15T10:00:00Z', 'e1')

    const res = await app.request(`/api/workspaces/${wsId}/events.csv`)
    const body = await res.text()
    // The text cell must be quoted with the inner quote doubled.
    expect(body).toContain('"a, ""b""\nc"')
  })

  it('leaves the text column empty for events with no textual payload', async () => {
    await insertEvent('task:updated', { taskId: 't1', done: true }, 'sess-1', '2026-05-15T10:00:00Z', 'e1')

    const res = await app.request(`/api/workspaces/${wsId}/events.csv`)
    const lines = (await res.text()).replace(/^﻿/, '').trim().split('\r\n')
    // created_at,session_id,type,text(empty),payload
    expect(lines[1]).toMatch(/,task:updated,,/)
  })
})
