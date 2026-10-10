import type Database from 'better-sqlite3'

/** Receipts survive workspace deletion; message bodies live only in normal chat/loop storage. */
export function initWorkspaceMessageBatchSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_message_batches (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`)
}
