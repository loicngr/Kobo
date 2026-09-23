import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initSchema } from '../server/db/schema.js'
import { searchEvents, stopSearchIndex } from '../server/services/search-service.js'

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
  await stopSearchIndex()
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
  it('returns empty array for empty query', async () => {
    expect(await searchEvents('')).toEqual([])
    expect(await searchEvents('   ')).toEqual([])
  })

  it('finds matches in user:message content', async () => {
    seedWorkspace('ws-1', 'My Workspace')
    seedEvent('ws-1', 'user:message', { content: 'Please refactor the authentication module', sender: 'user' })

    const results = await searchEvents('authentication')
    expect(results).toHaveLength(1)
    expect(results[0].workspaceId).toBe('ws-1')
    expect(results[0].workspaceName).toBe('My Workspace')
    expect(results[0].type).toBe('user:message')
    expect(results[0].snippet).toContain('authentication')
  })

  it('finds matches in agent:output text blocks', async () => {
    seedWorkspace('ws-1', 'Work')
    seedEvent('ws-1', 'agent:output', {
      type: 'assistant',
      message: {
        model: 'claude-opus-4-7',
        content: [{ type: 'text', text: 'I will now run the database migration script' }],
      },
    })

    const results = await searchEvents('migration')
    expect(results).toHaveLength(1)
    expect(results[0].type).toBe('agent:output')
    expect(results[0].snippet).toContain('migration')
  })

  it('finds matches in normalized agent:event message text', async () => {
    seedWorkspace('ws-1', 'Work')
    seedEvent('ws-1', 'agent:event', {
      kind: 'message:text',
      messageId: 'm-1',
      text: 'The websocket cursor is now persisted safely',
      streaming: false,
    })

    const results = await searchEvents('cursor')
    expect(results).toHaveLength(1)
    expect(results[0].type).toBe('agent:event')
    expect(results[0].snippet).toContain('cursor')
  })

  it('treats LIKE wildcard characters as literal search text', async () => {
    seedWorkspace('ws-1', 'Work')
    for (let i = 0; i < 160; i++) seedEvent('ws-1', 'user:message', { content: `unrelated message ${i}` })
    seedEvent('ws-1', 'user:message', { content: 'CPU reached 90% during the run' }, '2020-01-01T00:00:00Z')

    expect(await searchEvents('%')).toHaveLength(1)
  })

  it('ignores events that are not user:message or agent:output', async () => {
    seedWorkspace('ws-1', 'Work')
    seedEvent('ws-1', 'agent:status', { status: 'executing' })
    seedEvent('ws-1', 'task:updated', { title: 'executing migration' })

    expect(await searchEvents('executing')).toHaveLength(0)
    expect(await searchEvents('migration')).toHaveLength(0)
  })

  it('matches case-insensitively', async () => {
    seedWorkspace('ws-1', 'Work')
    seedEvent('ws-1', 'user:message', { content: 'Fix the BUG in production' })

    expect(await searchEvents('bug')).toHaveLength(1)
    expect(await searchEvents('BUG')).toHaveLength(1)
    expect(await searchEvents('Bug')).toHaveLength(1)
  })

  it('does not return false positives matching only JSON structure', async () => {
    seedWorkspace('ws-1', 'Work')
    seedEvent('ws-1', 'agent:output', {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello world' }] },
    })

    // "assistant" appears in the JSON structure but NOT in the readable text
    const results = await searchEvents('assistant')
    expect(results).toHaveLength(0)
  })

  it('keeps paging past JSON-only false positives to find older readable matches', async () => {
    seedWorkspace('ws-1', 'Work')
    seedEvent('ws-1', 'user:message', { content: 'the assistant found the actual answer' }, '2020-01-01T00:00:00Z')
    for (let i = 0; i < 180; i++) {
      seedEvent('ws-1', 'agent:output', {
        type: 'assistant',
        message: { content: [{ type: 'text', text: `unrelated response ${i}` }] },
      })
    }

    expect(await searchEvents('assistant')).toHaveLength(1)
  })

  it('builds a snippet with context around the match', async () => {
    seedWorkspace('ws-1', 'Work')
    const longText = `${'x'.repeat(300)} needle ${'y'.repeat(300)}`
    seedEvent('ws-1', 'user:message', { content: longText })

    const results = await searchEvents('needle')
    expect(results).toHaveLength(1)
    expect(results[0].snippet).toContain('needle')
    expect(results[0].snippet.length).toBeLessThanOrEqual(250)
  })

  it('respects the limit option', async () => {
    seedWorkspace('ws-1', 'Work')
    for (let i = 0; i < 10; i++) {
      seedEvent('ws-1', 'user:message', { content: `match ${i}` })
    }

    expect(await searchEvents('match', { limit: 3 })).toHaveLength(3)
    expect(await searchEvents('match', { limit: 100 })).toHaveLength(10)
  })

  it('excludes archived workspaces by default', async () => {
    seedWorkspace('ws-live', 'Live')
    seedWorkspace('ws-archived', 'Archived', '2026-04-01T00:00:00Z')
    seedEvent('ws-live', 'user:message', { content: 'unique-token-live' })
    seedEvent('ws-archived', 'user:message', { content: 'unique-token-archived' })

    expect(await searchEvents('unique-token-live')).toHaveLength(1)
    expect(await searchEvents('unique-token-archived')).toHaveLength(0)
  })

  it('includes archived workspaces when includeArchived is true', async () => {
    seedWorkspace('ws-archived', 'Archived', '2026-04-01T00:00:00Z')
    seedEvent('ws-archived', 'user:message', { content: 'from-archive' })

    const results = await searchEvents('from-archive', { includeArchived: true })
    expect(results).toHaveLength(1)
    expect(results[0].archived).toBe(true)
    expect(results[0].workspaceName).toBe('Archived')
  })

  it('returns most recent matches first', async () => {
    seedWorkspace('ws-1', 'Work')
    seedEvent('ws-1', 'user:message', { content: 'needle one' }, '2026-04-15T10:00:00Z')
    seedEvent('ws-1', 'user:message', { content: 'needle two' }, '2026-04-17T10:00:00Z')
    seedEvent('ws-1', 'user:message', { content: 'needle three' }, '2026-04-16T10:00:00Z')

    const results = await searchEvents('needle')
    expect(results.map((r) => r.timestamp)).toEqual([
      '2026-04-17T10:00:00Z',
      '2026-04-16T10:00:00Z',
      '2026-04-15T10:00:00Z',
    ])
  })
})

describe('logical message search regressions', () => {
  it('finds a word spanning streamed fragments as one complete message', async () => {
    seedWorkspace('ws-1', 'Work')
    seedEvent('ws-1', 'agent:event', { kind: 'message:text', messageId: 'same', text: 'authenti', streaming: true })
    seedEvent('ws-1', 'agent:event', { kind: 'message:text', messageId: 'same', text: 'cation fixed', streaming: true })
    const results = await searchEvents('authentication')
    expect(results).toHaveLength(1)
    expect(results[0].snippet).toContain('authentication fixed')
  })

  it('searches decoded text and normalized Unicode rather than raw JSON', async () => {
    seedWorkspace('ws-1', 'Work')
    seedEvent('ws-1', 'user:message', { content: 'ÉCHEC: "special value"' })
    expect(await searchEvents('échec')).toHaveLength(1)
    expect(await searchEvents('"special value"')).toHaveLength(1)
  })
})

it('cancels a real worker request and accepts subsequent searches', async () => {
  seedWorkspace('ws-1', 'Work')
  seedEvent('ws-1', 'user:message', { content: 'needle' })
  const controller = new AbortController()
  const pending = searchEvents('needle', {}, controller.signal)
  controller.abort()
  await expect(pending).rejects.toThrow('cancelled')
  expect(await searchEvents('needle')).toHaveLength(1)
})

it('stops a worker with pending requests before closing its database', async () => {
  seedWorkspace('ws-1', 'Work')
  seedEvent('ws-1', 'user:message', { content: 'needle' })
  const pending = searchEvents('needle')
  const rejected = expect(pending).rejects.toThrow('stopped')
  await stopSearchIndex()
  await rejected
  expect(await searchEvents('needle')).toHaveLength(1)
})

it('lets the main event loop run while a worker prepares search results', async () => {
  seedWorkspace('ws-1', 'Work')
  seedEvent('ws-1', 'user:message', { content: 'needle' })
  let yielded = false
  setImmediate(() => {
    yielded = true
  })
  expect(await searchEvents('needle')).toHaveLength(1)
  expect(yielded).toBe(true)
})
