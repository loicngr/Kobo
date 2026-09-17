import type Database from 'better-sqlite3'

export function initReviewReturnSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS pending_review_returns (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    review_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    original_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    original_configuration TEXT NOT NULL,
    review_configuration TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`)
}
