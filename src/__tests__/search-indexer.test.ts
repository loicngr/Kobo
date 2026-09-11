import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMigrations, SCHEMA_VERSION } from '../server/db/migrations.js'
import { SearchIndexer } from '../server/services/search/indexer.js'

let db: Database.Database
let indexer: SearchIndexer
const timestamp = '2026-09-11T00:00:00Z'
function event(id: string, text: string, messageId?: string, workspace = 'ws', session: string | null = null) {
  db.prepare(
    'INSERT INTO ws_events(id, workspace_id, session_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    workspace,
    session,
    messageId ? 'agent:event' : 'user:message',
    JSON.stringify(messageId ? { kind: 'message:text', text, messageId, streaming: true } : { content: text }),
    timestamp,
  )
}
beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys=ON')
  runMigrations(db)
  for (const id of ['ws', 'other'])
    db.prepare(
      `INSERT INTO workspaces(id,name,project_path,source_branch,working_branch,created_at,updated_at) VALUES (?,?,'/tmp','main','feature',?,?)`,
    ).run(id, id, timestamp, timestamp)
  indexer = new SearchIndexer(db)
})
afterEach(() => db.close())

it.each(['tick', 'removeDeleted'] as const)('serializes %s with concurrent WAL writers', (operation) => {
  event('old', 'needle')
  indexer.tick()
  db.prepare('DELETE FROM ws_events WHERE id = ?').run('old')
  const directory = mkdtempSync(join(tmpdir(), 'kobo-search-wal-'))
  const filename = join(directory, 'test.db')
  writeFileSync(filename, db.serialize())
  db.close()
  db = new Database(filename)
  db.pragma('journal_mode=WAL')
  const writer = new Database(filename, { timeout: 0 })
  const update = writer.prepare("UPDATE workspaces SET name = 'concurrent writer' WHERE id = 'ws'")
  const prepare = db.prepare.bind(db)
  let attempted = false
  let writerError: unknown
  const tryConcurrentWrite = () => {
    attempted = true
    try {
      update.run()
    } catch (error) {
      writerError = error
    }
  }
  const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql)
    if (operation === 'tick' && sql === 'SELECT * FROM search_index_state WHERE id = 1' && !attempted) {
      const get = statement.get.bind(statement)
      statement.get = () => {
        const result = get()
        tryConcurrentWrite()
        return result
      }
    } else if (operation === 'removeDeleted' && sql.startsWith('SELECT DISTINCT f.event_id')) {
      const all = statement.all.bind(statement)
      statement.all = () => {
        const result = all()
        tryConcurrentWrite()
        return result
      }
    }
    return statement
  })
  try {
    expect(() => new SearchIndexer(db)[operation]()).not.toThrow()
    expect(attempted).toBe(true)
    expect(writerError).toMatchObject({ code: 'SQLITE_BUSY' })
    expect(() => update.run()).not.toThrow()
    expect(db.prepare('SELECT count(*) AS n FROM search_messages').get()).toEqual({ n: 0 })
  } finally {
    spy.mockRestore()
    writer.close()
    db.close()
    db = new Database(':memory:')
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('derived search index', () => {
  it('keeps message identity scoped to workspace and session and follows event order', async () => {
    event('z', 'authenti', 'm', 'ws', 'a')
    event('a', 'cation', 'm', 'ws', 'a')
    event('b', 'other', 'm', 'other', 'a')
    event('c', 'different', 'm', 'ws', 'b')
    indexer.tick()
    expect(await indexer.search('authentication')).toMatchObject([{ eventId: 'z', sessionId: 'a', workspaceId: 'ws' }])
    expect(await indexer.search('authentication', { workspaceId: 'other' })).toEqual([])
    expect(await indexer.search('authenticationother')).toEqual([])
  })

  it('resumes partial backfill and never restores deleted fragments', async () => {
    db.transaction(() => {
      for (let i = 0; i < 1200; i++) event(`event-${String(i).padStart(4, '0')}`, `needle ${i}`)
    })()
    expect(indexer.tick().state).toBe('building')
    expect((await indexer.search('needle')).length).toBeGreaterThan(0)
    db.prepare('DELETE FROM ws_events WHERE id = ?').run('event-0001')
    indexer = new SearchIndexer(db)
    expect(await indexer.search('needle 1', { limit: 200 })).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ eventId: 'event-0001' })]),
    )
    while (indexer.tick().state !== 'ready') {
      /* resume bounded batches */
    }
    expect(db.prepare('SELECT count(*) AS n FROM search_messages').get()).toEqual({ n: 1199 })
    expect(db.prepare('SELECT count(*) AS n FROM ws_events').get()).toEqual({ n: 1199 })
  })

  it('rebuilds messages on event edits and deletes and cascades workspace deletion', async () => {
    event('a', 'authenti', 'm')
    event('b', 'cation', 'm')
    indexer.tick()
    db.prepare('DELETE FROM ws_events WHERE id = ?').run('b')
    expect(await indexer.search('authentication')).toEqual([])
    db.prepare('UPDATE ws_events SET payload = ? WHERE id = ?').run(
      JSON.stringify({ kind: 'message:text', messageId: 'm', text: 'updated' }),
      'a',
    )
    indexer.tick()
    expect(await indexer.search('updated')).toHaveLength(1)
    db.prepare('DELETE FROM workspaces WHERE id = ?').run('ws')
    expect(await indexer.search('updated')).toEqual([])
    expect(db.prepare('SELECT count(*) AS n FROM search_fragments').get()).toEqual({ n: 0 })
  })

  it('preserves literal substring semantics for short and Unicode queries', async () => {
    event('a', 'E\u0301CHEC "special value" 100%_ \\path')
    indexer.tick()
    for (const q of ['échec', '"special value"', '%_', '\\path', 'ch']) expect(await indexer.search(q)).toHaveLength(1)
    expect(await indexer.search('field:message')).toEqual([])
    await expect(indexer.search('ch', {}, () => true)).rejects.toThrow('cancelled')
  })

  it('upgrades v41 without changing source rows and converges with a fresh schema', () => {
    event('old', 'historical message')
    const source = db.prepare('SELECT * FROM ws_events').all()
    const searchObjects = db
      .prepare(
        "SELECT type,name FROM sqlite_master WHERE name LIKE 'search_%' AND type IN ('trigger','table') ORDER BY CASE type WHEN 'trigger' THEN 0 ELSE 1 END",
      )
      .all() as { type: string; name: string }[]
    // Drop the virtual table first, then its remaining derived tables (its shadow
    // tables are removed automatically). This reconstructs a v41 fixture only.
    for (const object of searchObjects.filter((o) => o.type === 'trigger')) db.exec(`DROP TRIGGER "${object.name}"`)
    db.exec('DROP TABLE search_messages_fts')
    for (const name of ['search_fragments', 'search_messages', 'search_changes', 'search_index_state'])
      db.exec(`DROP TABLE ${name}`)
    db.prepare('DELETE FROM schema_migrations WHERE version = 42').run()
    runMigrations(db)
    expect(db.prepare('SELECT * FROM ws_events').all()).toEqual(source)
    expect(db.prepare('SELECT max(version) AS version FROM schema_migrations').get()).toEqual({
      version: SCHEMA_VERSION,
    })
    const fresh = new Database(':memory:')
    runMigrations(fresh)
    const shape = (connection: Database.Database) =>
      connection
        .prepare(
          "SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'search_%' OR name LIKE 'idx_search_%' ORDER BY name",
        )
        .all()
    expect(shape(db)).toEqual(shape(fresh))
    fresh.close()
    expect(indexer.tick().state).toBe('ready')
  })
})

it('keeps fragment order when VACUUM renumbers source rows during backfill', async () => {
  event('z-removed-1', 'unrelated')
  event('z-removed-2', 'unrelated')
  event('b-prefix', 'prefix ', 'same')
  event('a-middle', 'middle ', 'same')
  event('c-end', 'end', 'same')
  // Backfill is keyed by stable IDs, so the middle is processed first.
  db.exec('DELETE FROM search_changes')
  indexer.tick(1)
  db.prepare("DELETE FROM ws_events WHERE id LIKE 'z-removed-%'").run()
  db.exec('VACUUM')
  while (indexer.tick(1).state !== 'ready') {
    /* resume */
  }
  expect(await indexer.search('prefix middle end')).toHaveLength(1)
})

it('keeps the matched word visible in snippets after Unicode normalization', async () => {
  event('decomposed', `${'e\u0301'.repeat(300)}needle`)
  event('case-expansion', `${'İ'.repeat(300)}needle`)
  indexer.tick()
  const results = await indexer.search('needle')
  expect(results).toHaveLength(2)
  for (const result of results) expect(result.snippet).toContain('needle')
})

it('anchors different matches to their source fragments after Unicode normalization', async () => {
  event('z-prefix', 'İe\u0301'.repeat(300), 'long')
  event('a-accent', ' E', 'long')
  event('b-word', '\u0301CHEC authenti', 'long')
  event('c-end', 'cation', 'long')
  indexer.tick()
  expect(await indexer.search('échec')).toMatchObject([
    { eventId: 'a-accent', snippet: expect.stringContaining('ÉCHEC') },
  ])
  expect(await indexer.search('authentication')).toMatchObject([{ eventId: 'b-word' }])
  expect(await indexer.search('cation')).toMatchObject([{ eventId: 'c-end' }])
})

it('applies deletions ahead of a backlog larger than the next batch', async () => {
  event('old', 'old needle')
  indexer.tick()
  db.transaction(() => {
    for (let i = 0; i < 600; i++) event(`new-${i}`, 'unrelated')
  })()
  db.prepare('DELETE FROM ws_events WHERE id = ?').run('old')
  expect(await indexer.search('old needle')).toEqual([])
  while (indexer.tick().state !== 'ready') {
    /* drain */
  }
  expect(await indexer.search('old needle')).toEqual([])
})
