import type Database from 'better-sqlite3'

export function initBrowserSessionSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS browser_sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    policy_fingerprint TEXT NOT NULL
  )`)
}
