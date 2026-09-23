import type Database from 'better-sqlite3'

/** Shared by fresh installs and the append-only upgrade. */
export function initAutoLoopSchema(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
  if (columns.length) {
    if (!columns.some((c) => c.name === 'role'))
      db.exec("ALTER TABLE tasks ADD COLUMN role TEXT NOT NULL DEFAULT 'work'")
    if (!columns.some((c) => c.name === 'verification')) db.exec('ALTER TABLE tasks ADD COLUMN verification TEXT')
    if (columns.some((c) => c.name === 'title')) {
      db.exec("UPDATE tasks SET role = 'finalization' WHERE title LIKE '[FINAL] %' AND role = 'work'")
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS auto_loop_runs (
      workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      phase TEXT NOT NULL DEFAULT 'grooming',
      state TEXT NOT NULL DEFAULT 'waiting',
      reason TEXT,
      iteration INTEGER NOT NULL DEFAULT 0,
      diagnostic_attempts INTEGER NOT NULL DEFAULT 0,
      current_task_id TEXT,
      current_session_id TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auto_loop_progress (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      milestone INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (workspace_id, task_id)
    );
    CREATE TABLE IF NOT EXISTS auto_loop_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      client_message_id TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT,
      state TEXT NOT NULL DEFAULT 'pending',
      session_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (workspace_id, client_message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_auto_loop_messages_pending ON auto_loop_messages(workspace_id, state, id);
  `)
}
