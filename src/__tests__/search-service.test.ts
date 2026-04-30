import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initSchema } from '../server/db/schema.js'
import { searchEvents } from '../server/services/search-service.js'

let tmpDir: string
let dbPath: string

async function resetDb(): Promise<void> {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-search-test-'))
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
})

afterEach(async () => {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

function seedWorkspace(id: string, name: string, archivedAt: string | null = null): void {
  const db = new Database(dbPath)
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, status, archived_at, created_at, updated_at)
     VALUES (?, ?, '/tmp', 'main', 'feat', 'created', ?, ?, ?)`,
  ).run(id, name, archivedAt, now, now)
  db.close()
}

function seedEvent(workspaceId: string, type: string, payload: object, createdAt?: string): void {
  const db = new Database(dbPath)
  db.prepare(`INSERT INTO ws_events (id, workspace_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    `evt-${Math.random().toString(36).slice(2, 10)}`,
    workspaceId,
    type,
    JSON.stringify(payload),
    createdAt ?? new Date().toISOString(),
  )
  db.close()
}

describe('searchEvents', () => {
  it('returns empty array for empty query', () => {
    expect(searchEvents('')).toEqual([])
    expect(searchEvents('   ')).toEqual([])
  })

  it('finds matches in user:message content', () => {
    seedWorkspace('ws-1', 'My Workspace')
    seedEvent('ws-1', 'user:message', { content: 'Please refactor the authentication module', sender: 'user' })

    const results = searchEvents('authentication')
    expect(results).toHaveLength(1)
    expect(results[0].workspaceId).toBe('ws-1')
    expect(results[0].workspaceName).toBe('My Workspace')
    expect(results[0].type).toBe('user:message')
    expect(results[0].snippet).toContain('authentication')
  })

  it('finds matches in agent:output text blocks', () => {
    seedWorkspace('ws-1', 'Work')
    seedEvent('ws-1', 'agent:output', {
      type: 'assistant',
      message: {
        model: 'claude-opus-4-7',
        content: [{ type: 'text', text: 'I will now run the database migration script' }],
      },
    })

    const results = searchEvents('migration')
    expect(results).toHaveLength(1)
    expect(results[0].type).toBe('agent:output')
    expect(results[0].snippet).toContain('migration')
  })

  it('ignores events that are not user:message or agent:output', () => {
    seedWorkspace('ws-1', 'Work')
    seedEvent('ws-1', 'agent:status', { status: 'executing' })
    seedEvent('ws-1', 'task:updated', { title: 'executing migration' })

    expect(searchEvents('executing')).toHaveLength(0)
    expect(searchEvents('migration')).toHaveLength(0)
  })

  it('matches case-insensitively', () => {
    seedWorkspace('ws-1', 'Work')
    seedEvent('ws-1', 'user:message', { content: 'Fix the BUG in production' })

    expect(searchEvents('bug')).toHaveLength(1)
    expect(searchEvents('BUG')).toHaveLength(1)
    expect(searchEvents('Bug')).toHaveLength(1)
  })

  it('does not return false positives matching only JSON structure', () => {
    seedWorkspace('ws-1', 'Work')
    seedEvent('ws-1', 'agent:output', {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello world' }] },
    })

    // "assistant" appears in the JSON structure but NOT in the readable text
    const results = searchEvents('assistant')
    expect(results).toHaveLength(0)
  })

  it('builds a snippet with context around the match', () => {
    seedWorkspace('ws-1', 'Work')
    const longText = `${'x'.repeat(300)} needle ${'y'.repeat(300)}`
    seedEvent('ws-1', 'user:message', { content: longText })

    const results = searchEvents('needle')
    expect(results).toHaveLength(1)
    expect(results[0].snippet).toContain('needle')
    expect(results[0].snippet.length).toBeLessThanOrEqual(250)
  })

  it('respects the limit option', () => {
    seedWorkspace('ws-1', 'Work')
    for (let i = 0; i < 10; i++) {
      seedEvent('ws-1', 'user:message', { content: `match ${i}` })
    }

    expect(searchEvents('match', { limit: 3 })).toHaveLength(3)
    expect(searchEvents('match', { limit: 100 })).toHaveLength(10)
  })

  it('excludes archived workspaces by default', () => {
    seedWorkspace('ws-live', 'Live')
    seedWorkspace('ws-archived', 'Archived', '2026-04-01T00:00:00Z')
    seedEvent('ws-live', 'user:message', { content: 'unique-token-live' })
    seedEvent('ws-archived', 'user:message', { content: 'unique-token-archived' })

    expect(searchEvents('unique-token-live')).toHaveLength(1)
    expect(searchEvents('unique-token-archived')).toHaveLength(0)
  })

  it('includes archived workspaces when includeArchived is true', () => {
    seedWorkspace('ws-archived', 'Archived', '2026-04-01T00:00:00Z')
    seedEvent('ws-archived', 'user:message', { content: 'from-archive' })

    const results = searchEvents('from-archive', { includeArchived: true })
    expect(results).toHaveLength(1)
    expect(results[0].archived).toBe(true)
    expect(results[0].workspaceName).toBe('Archived')
  })

  it('returns most recent matches first', () => {
    seedWorkspace('ws-1', 'Work')
    seedEvent('ws-1', 'user:message', { content: 'needle one' }, '2026-04-15T10:00:00Z')
    seedEvent('ws-1', 'user:message', { content: 'needle two' }, '2026-04-17T10:00:00Z')
    seedEvent('ws-1', 'user:message', { content: 'needle three' }, '2026-04-16T10:00:00Z')

    const results = searchEvents('needle')
    expect(results.map((r) => r.timestamp)).toEqual([
      '2026-04-17T10:00:00Z',
      '2026-04-16T10:00:00Z',
      '2026-04-15T10:00:00Z',
    ])
  })
})
