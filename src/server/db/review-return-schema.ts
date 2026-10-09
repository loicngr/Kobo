import type Database from 'better-sqlite3'

export function initReviewReturnSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS pending_review_returns (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    review_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    original_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    original_configuration TEXT NOT NULL,
    review_configuration TEXT NOT NULL,
    created_at TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'reviewing',
    review_prompt TEXT,
    return_prompt TEXT,
    last_error TEXT
  )`)
}

/** v52: retain the return intent and its dispatch boundary across server restarts. */
export function migrateDurableReviewReturns(db: Database.Database): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(pending_review_returns)').all() as Array<{ name: string }>).map((row) => row.name),
  )
  for (const [name, declaration] of Object.entries({
    phase: "TEXT NOT NULL DEFAULT 'reviewing'",
    review_prompt: 'TEXT',
    return_prompt: 'TEXT',
    last_error: 'TEXT',
  })) {
    if (!columns.has(name)) db.exec(`ALTER TABLE pending_review_returns ADD COLUMN ${name} ${declaration}`)
  }
}
