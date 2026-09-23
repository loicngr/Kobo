import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { initSchema } from '../../server/db/schema.js'

/**
 * Test helper: tear down the singleton DB, create a fresh temporary SQLite
 * file with the latest schema, and rebind the singleton to it. Use in
 * `beforeEach` to ensure every test starts from an empty, fully-migrated DB.
 */
export async function resetDb(): Promise<{ tmpDir: string; dbPath: string }> {
  const { closeDb, getDb } = await import('../../server/db/index.js')
  closeDb()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-reset-db-'))
  // Isolate the test from the real Kōbō home — if any imported module
  // calls `getDb()` without a custom path (e.g. after `vi.resetModules()`
  // fresh-imports a service), it would otherwise hit
  // `$XDG_CONFIG_HOME/kobo/kobo.db` and silently mutate the user's prod DB.
  process.env.KOBO_HOME = tmpDir
  const dbPath = path.join(tmpDir, 'test.db')
  // Pre-create and migrate the DB before the singleton picks it up
  const db = new Database(dbPath)
  db.pragma('journal_mode=WAL')
  db.pragma('foreign_keys=ON')
  initSchema(db)
  db.close()
  getDb(dbPath)
  return { tmpDir, dbPath }
}
