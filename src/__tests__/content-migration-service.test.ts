import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/services/websocket-service.js', () => ({
  emit: vi.fn(),
  emitEphemeral: vi.fn(),
  broadcast: vi.fn(),
  broadcastAll: vi.fn(),
}))

describe('content-migration-service', () => {
  let tmpDir: string
  let dbPath: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kobo-cm-'))
    dbPath = join(tmpDir, 'kobo.db')
    db = new Database(dbPath)
    db.prepare(
      'CREATE TABLE ws_events (id TEXT PRIMARY KEY, workspace_id TEXT, type TEXT, payload TEXT, session_id TEXT, created_at TEXT)',
    ).run()
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reports idle status when there is nothing to migrate', async () => {
    const { runContentMigrationIfNeeded, getContentMigrationStatus } = await import(
      '../server/services/content-migration-service.js'
    )
    await runContentMigrationIfNeeded(db, dbPath)
    expect(getContentMigrationStatus().state).toBe('idle')
  })
})

describe('content-migration-service — conversion', () => {
  let tmpDir: string
  let dbPath: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kobo-cm-'))
    dbPath = join(tmpDir, 'kobo.db')
    db = new Database(dbPath)
    db.prepare(
      'CREATE TABLE ws_events (id TEXT PRIMARY KEY, workspace_id TEXT, type TEXT, payload TEXT, session_id TEXT, created_at TEXT)',
    ).run()
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('converts agent:output rows via the Claude stream parser', async () => {
    const { _resetStatusForTest } = await import('../server/services/content-migration-service.js')
    _resetStatusForTest()
    db.prepare(
      "INSERT INTO ws_events (id, workspace_id, type, payload, session_id, created_at) VALUES (?, ?, 'agent:output', ?, ?, ?)",
    ).run(
      'r1',
      'w1',
      JSON.stringify({
        type: 'assistant',
        session_id: 's1',
        message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
      }),
      'sess-1',
      '2025-01-01T00:00:00Z',
    )

    const { runContentMigrationIfNeeded } = await import('../server/services/content-migration-service.js')
    await runContentMigrationIfNeeded(db, dbPath)

    const remaining = db.prepare("SELECT COUNT(*) AS c FROM ws_events WHERE type = 'agent:output'").get() as {
      c: number
    }
    expect(remaining.c).toBe(0)

    const newRows = db
      .prepare("SELECT workspace_id, session_id, created_at, payload FROM ws_events WHERE type = 'agent:event'")
      .all() as Array<{ workspace_id: string; session_id: string; created_at: string; payload: string }>
    expect(newRows).toHaveLength(1)
    expect(newRows[0].workspace_id).toBe('w1')
    expect(newRows[0].session_id).toBe('sess-1')
    expect(newRows[0].created_at).toBe('2025-01-01T00:00:00Z')
    const ev = JSON.parse(newRows[0].payload)
    expect(ev.kind).toBe('message:text')
    expect(ev.text).toBe('Hello')
  })

  it('drops agent:status rows (no new row inserted)', async () => {
    const { _resetStatusForTest } = await import('../server/services/content-migration-service.js')
    _resetStatusForTest()
    db.prepare(
      "INSERT INTO ws_events (id, workspace_id, type, payload, session_id, created_at) VALUES (?, ?, 'agent:status', ?, ?, ?)",
    ).run('r1', 'w1', JSON.stringify({ status: 'running' }), 'sess-1', '2025-01-01T00:00:00Z')
    const { runContentMigrationIfNeeded } = await import('../server/services/content-migration-service.js')
    await runContentMigrationIfNeeded(db, dbPath)
    const any = db.prepare('SELECT COUNT(*) AS c FROM ws_events').get() as { c: number }
    expect(any.c).toBe(0)
  })

  it('drops agent:stderr rows (no event inserted)', async () => {
    // stderr is dropped to avoid turning historical Claude CLI warnings into
    // UI error banners. The new engine only logs non-quota stderr via
    // console.warn, so replaying legacy rows as errors would be a regression.
    const { _resetStatusForTest } = await import('../server/services/content-migration-service.js')
    _resetStatusForTest()
    db.prepare(
      "INSERT INTO ws_events (id, workspace_id, type, payload, session_id, created_at) VALUES (?, ?, 'agent:stderr', ?, ?, ?)",
    ).run('r1', 'w1', JSON.stringify({ content: 'Warning: no stdin data' }), 'sess-1', '2025-01-01T00:00:00Z')
    const { runContentMigrationIfNeeded } = await import('../server/services/content-migration-service.js')
    await runContentMigrationIfNeeded(db, dbPath)
    const count = db.prepare('SELECT COUNT(*) AS c FROM ws_events').get() as { c: number }
    expect(count.c).toBe(0)
  })

  it('idempotent: second run is a no-op', async () => {
    const { _resetStatusForTest } = await import('../server/services/content-migration-service.js')
    _resetStatusForTest()
    const { runContentMigrationIfNeeded, getContentMigrationStatus } = await import(
      '../server/services/content-migration-service.js'
    )
    await runContentMigrationIfNeeded(db, dbPath)
    _resetStatusForTest()
    await runContentMigrationIfNeeded(db, dbPath)
    expect(getContentMigrationStatus().state).toBe('idle')
  })

  it('logs a warn (with workspace context + payload preview) when agent:output payload is unparseable', async () => {
    const { convertRow } = await import('../server/services/content-migration-service.js')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // `{not json` makes JSON.parse throw — convertRow should catch, log, and
      // fall back to a message:raw event.
      const events = convertRow('agent:output', '{not json', { workspaceId: 'ws-xyz' })
      expect(events).toEqual([{ kind: 'message:raw', content: '{not json' }])
      expect(warnSpy).toHaveBeenCalled()
      const firstCall = warnSpy.mock.calls[0]?.[0] ?? ''
      expect(String(firstCall)).toContain('ws-xyz')
      expect(String(firstCall)).toContain('{not json')
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('content-migration-service — error paths', () => {
  let tmpDir: string
  let dbPath: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kobo-cm-'))
    dbPath = join(tmpDir, 'kobo.db')
    db = new Database(dbPath)
    db.prepare(
      'CREATE TABLE ws_events (id TEXT PRIMARY KEY, workspace_id TEXT, type TEXT, payload TEXT, session_id TEXT, created_at TEXT)',
    ).run()
    // Seed one legacy row so the migration actually runs past the early exit
    db.prepare(
      "INSERT INTO ws_events (id, workspace_id, type, payload, session_id, created_at) VALUES (?, ?, 'agent:output', ?, ?, ?)",
    ).run(
      'r1',
      'w1',
      JSON.stringify({
        type: 'assistant',
        session_id: 's1',
        message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'X' }] },
      }),
      'sess-1',
      '2025-01-01T00:00:00Z',
    )
  })

  afterEach(() => {
    try {
      db.close()
    } catch {
      // may already be closed in some tests
    }
    rmSync(tmpDir, { recursive: true, force: true })
    vi.doUnmock('../server/services/db-backup-service.js')
    vi.resetModules()
  })

  it('sets status to error when the pre-migration backup fails', async () => {
    vi.resetModules()
    vi.doMock('../server/services/db-backup-service.js', () => ({
      createPreMigrationBackup: vi.fn().mockRejectedValue(new Error('disk is full')),
    }))
    const { runContentMigrationIfNeeded, getContentMigrationStatus, _resetStatusForTest } = await import(
      '../server/services/content-migration-service.js'
    )
    _resetStatusForTest()
    await expect(runContentMigrationIfNeeded(db, dbPath)).rejects.toThrow(/disk is full/)
    expect(getContentMigrationStatus().state).toBe('error')
    expect(getContentMigrationStatus().errorMessage).toMatch(/disk is full/)
  })

  it('sets status to error when a batch throws (insert failure inside transaction)', async () => {
    vi.resetModules()
    vi.doMock('../server/services/db-backup-service.js', () => ({
      createPreMigrationBackup: vi.fn().mockResolvedValue({ created: null }),
    }))
    const { runContentMigrationIfNeeded, getContentMigrationStatus, _resetStatusForTest } = await import(
      '../server/services/content-migration-service.js'
    )
    _resetStatusForTest()
    // Drop the table after select but before insert runs, by intercepting
    // the select's `.all()` call. This causes the INSERT inside the
    // transaction to fail and bubble the error up.
    const origPrepare = db.prepare.bind(db)
    let firstSelectCalled = false
    type AnyRec = Record<string, unknown>
    ;(db as unknown as AnyRec).prepare = (sql: string) => {
      const stmt = origPrepare(sql)
      if (sql.includes('SELECT id, workspace_id') && !firstSelectCalled) {
        firstSelectCalled = true
        const origAll = stmt.all.bind(stmt)
        ;(stmt as unknown as AnyRec).all = (limit: number) => {
          const rows = origAll(limit)
          // Drop the table using the better-sqlite3 prepared-statement API.
          origPrepare('DROP TABLE ws_events').run()
          return rows
        }
      }
      return stmt
    }
    await expect(runContentMigrationIfNeeded(db, dbPath)).rejects.toThrow()
    expect(getContentMigrationStatus().state).toBe('error')
    expect(getContentMigrationStatus().errorMessage).toBeTruthy()
  })
})
