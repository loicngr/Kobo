import type Database from 'better-sqlite3'

export function initProgressBarSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS session_progress_bars (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    owner_kind TEXT NOT NULL CHECK(owner_kind IN ('internal','external')),
    owner_launch_id TEXT NOT NULL,
    activity_key TEXT NOT NULL,
    creation_fingerprint TEXT NOT NULL,
    producer_fingerprint TEXT,
    producer_updated_at TEXT,
    label TEXT NOT NULL,
    step TEXT,
    current REAL,
    total REAL,
    status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','interrupted')),
    dismissed_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    sequence INTEGER NOT NULL DEFAULT 0,
    UNIQUE(workspace_id,session_id,owner_kind,owner_launch_id,activity_key)
  );
  CREATE INDEX IF NOT EXISTS idx_progress_bars_session ON session_progress_bars(workspace_id,session_id,created_at,id);
  CREATE INDEX IF NOT EXISTS idx_progress_bars_launch ON session_progress_bars(owner_kind,owner_launch_id,status);`)
}
