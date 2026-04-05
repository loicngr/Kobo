import type Database from 'better-sqlite3'
import { initSchema } from './schema.js'

export const SCHEMA_VERSION = 1

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    )
  `)

  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined

  const currentVersion = row?.version ?? 0

  if (currentVersion < 1) {
    initSchema(db)
    if (currentVersion === 0) {
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(1)
    } else {
      db.prepare('UPDATE schema_version SET version = ?').run(1)
    }
  }
}
