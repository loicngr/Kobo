import type Database from 'better-sqlite3'

/** Derived data only. The event log remains the source of truth. */
export function initSearchSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_index_state (
      id INTEGER PRIMARY KEY CHECK(id = 1), cursor TEXT NOT NULL DEFAULT '',
      complete INTEGER NOT NULL DEFAULT 0, processed INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT -1, base_order INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO search_index_state(id, base_order)
      SELECT 1, COALESCE(MAX(rowid), 0) FROM ws_events;
    CREATE TABLE IF NOT EXISTS search_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, operation TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_search_changes_event ON search_changes(event_id);
    CREATE TABLE IF NOT EXISTS search_fragments (
      event_id TEXT PRIMARY KEY, message_key TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      session_id TEXT, type TEXT NOT NULL, created_at TEXT NOT NULL,
      event_order INTEGER NOT NULL, text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_search_fragments_message ON search_fragments(message_key, event_order);
    CREATE TABLE IF NOT EXISTS search_messages (
      id INTEGER PRIMARY KEY, message_key TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      session_id TEXT, event_id TEXT NOT NULL, type TEXT NOT NULL,
      created_at TEXT NOT NULL, text TEXT NOT NULL, normalized TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_search_messages_workspace ON search_messages(workspace_id, created_at DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS search_messages_fts USING fts5(
      normalized, content='search_messages', content_rowid='id', tokenize='trigram case_sensitive 1'
    );
    CREATE TRIGGER IF NOT EXISTS search_messages_insert AFTER INSERT ON search_messages BEGIN
      INSERT INTO search_messages_fts(rowid, normalized) VALUES (new.id, new.normalized);
    END;
    CREATE TRIGGER IF NOT EXISTS search_messages_delete AFTER DELETE ON search_messages BEGIN
      INSERT INTO search_messages_fts(search_messages_fts, rowid, normalized) VALUES ('delete', old.id, old.normalized);
    END;
    CREATE TRIGGER IF NOT EXISTS search_messages_update AFTER UPDATE ON search_messages BEGIN
      INSERT INTO search_messages_fts(search_messages_fts, rowid, normalized) VALUES ('delete', old.id, old.normalized);
      INSERT INTO search_messages_fts(rowid, normalized) VALUES (new.id, new.normalized);
    END;
    CREATE TRIGGER IF NOT EXISTS search_events_insert AFTER INSERT ON ws_events BEGIN
      INSERT INTO search_changes(event_id, operation) VALUES(new.id, 'insert');
    END;
    CREATE TRIGGER IF NOT EXISTS search_events_update AFTER UPDATE ON ws_events BEGIN
      INSERT INTO search_changes(event_id, operation) VALUES(old.id, 'update');
      INSERT INTO search_changes(event_id, operation) SELECT new.id, 'update' WHERE new.id != old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS search_events_delete AFTER DELETE ON ws_events BEGIN
      INSERT INTO search_changes(event_id, operation) VALUES(old.id, 'delete');
    END;
  `)
}
