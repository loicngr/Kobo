import type Database from 'better-sqlite3'

export function initSessionHandoffSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS session_handoffs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    source_session_id TEXT,
    target_session_id TEXT,
    source_configuration TEXT NOT NULL,
    target_configuration TEXT NOT NULL,
    source_model TEXT,
    generate_summary INTEGER NOT NULL,
    state TEXT NOT NULL,
    report TEXT,
    report_path TEXT,
    generation_token TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(workspace_id, request_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS session_handoffs_pending
    ON session_handoffs(workspace_id) WHERE state NOT IN ('completed', 'cancelled');`)
}
