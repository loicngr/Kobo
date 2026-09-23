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

/**
 * The legacy stream-parser was removed during the Claude Agent SDK cutover.
 * All production databases have already been migrated, so the content
 * migration is now a no-op that always reports `idle`. These tests lock that
 * contract — they no longer assert on parser-driven conversion behaviour.
 */
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
    const { runContentMigrationIfNeeded, getContentMigrationStatus, _resetStatusForTest } = await import(
      '../server/services/content-migration-service.js'
    )
    _resetStatusForTest()
    await runContentMigrationIfNeeded(db, dbPath)
    expect(getContentMigrationStatus().state).toBe('idle')
  })

  it('reports idle status even when legacy rows are present (skip-entirely strategy)', async () => {
    const { runContentMigrationIfNeeded, getContentMigrationStatus, _resetStatusForTest } = await import(
      '../server/services/content-migration-service.js'
    )
    _resetStatusForTest()
    db.prepare(
      "INSERT INTO ws_events (id, workspace_id, type, payload, session_id, created_at) VALUES (?, ?, 'agent:output', ?, ?, ?)",
    ).run('r1', 'w1', JSON.stringify({ type: 'raw', content: 'legacy' }), 'sess-1', '2025-01-01T00:00:00Z')
    await runContentMigrationIfNeeded(db, dbPath)
    expect(getContentMigrationStatus().state).toBe('idle')
    // Legacy row is left untouched in the table — replay path now only reads
    // `agent:event` rows and ignores the legacy types.
    const remaining = db.prepare("SELECT COUNT(*) AS c FROM ws_events WHERE type = 'agent:output'").get() as {
      c: number
    }
    expect(remaining.c).toBe(1)
  })

  it('convertRow returns an empty event array for every legacy type', async () => {
    const { convertRow } = await import('../server/services/content-migration-service.js')
    expect(convertRow('agent:output', JSON.stringify({ type: 'raw', content: 'x' }))).toEqual([])
    expect(convertRow('agent:status', JSON.stringify({ status: 'running' }))).toEqual([])
    expect(convertRow('agent:stderr', JSON.stringify({ content: 'warn' }))).toEqual([])
    expect(convertRow('agent:output', '{not json')).toEqual([])
  })

  it('idempotent: second run is still a no-op', async () => {
    const { runContentMigrationIfNeeded, getContentMigrationStatus, _resetStatusForTest } = await import(
      '../server/services/content-migration-service.js'
    )
    _resetStatusForTest()
    await runContentMigrationIfNeeded(db, dbPath)
    _resetStatusForTest()
    await runContentMigrationIfNeeded(db, dbPath)
    expect(getContentMigrationStatus().state).toBe('idle')
  })
})
