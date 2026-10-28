import type Database from 'better-sqlite3'

export function initPinnedMessageSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pinned_messages (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES agent_sessions(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL,
      event_ids TEXT NOT NULL,
      item_keys TEXT NOT NULL,
      speaker TEXT NOT NULL CHECK (speaker IN ('user', 'agent')),
      preview TEXT NOT NULL,
      message_created_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      snapshot TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pinned_messages_workspace_created
      ON pinned_messages(workspace_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_pinned_messages_created
      ON pinned_messages(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_pinned_messages_session ON pinned_messages(session_id);
  `)
}
