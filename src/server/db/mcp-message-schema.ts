import type Database from 'better-sqlite3'

/** v43 schema shared by fresh installs and the append-only migration. */
export function initMcpMessageSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS mcp_message_requests (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('reserved','dispatching','accepted','rejected','unknown')),
    result_json TEXT,
    event_id TEXT,
    session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, idempotency_key)
  )`)
}
