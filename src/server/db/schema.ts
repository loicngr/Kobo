import type Database from 'better-sqlite3'

/** Create all tables and indexes for a fresh install. Not used for upgrades -- see migrations.ts. */
export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project_path TEXT NOT NULL,
      source_branch TEXT NOT NULL,
      working_branch TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'created',
      notion_url TEXT,
      notion_page_id TEXT,
      sentry_url TEXT,
      worktree_path TEXT,
      worktree_owned INTEGER NOT NULL DEFAULT 1,
      model TEXT NOT NULL DEFAULT 'claude-opus-4-7',
      reasoning_effort TEXT NOT NULL DEFAULT 'auto',
      permission_mode TEXT NOT NULL DEFAULT 'auto-accept',
      dev_server_status TEXT NOT NULL DEFAULT 'stopped',
      has_unread INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      favorited_at TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      engine TEXT NOT NULL DEFAULT 'claude-code',
      auto_loop INTEGER NOT NULL DEFAULT 0,
      auto_loop_ready INTEGER NOT NULL DEFAULT 0,
      no_progress_streak INTEGER NOT NULL DEFAULT 0,
      permission_profile TEXT NOT NULL DEFAULT 'bypass',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      is_acceptance_criterion INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      pid INTEGER,
      engine_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      name TEXT
    );

    CREATE TABLE IF NOT EXISTS ws_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      session_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_wakeups (
      workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      target_at    TEXT NOT NULL,
      prompt       TEXT NOT NULL,
      reason       TEXT,
      created_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage_snapshots (
      provider_id   TEXT PRIMARY KEY,
      status        TEXT NOT NULL,
      error_message TEXT,
      buckets_json  TEXT NOT NULL,
      fetched_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_workspace_id ON tasks(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_workspace_id ON agent_sessions(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_ws_events_workspace_id ON ws_events(workspace_id);
  `)
}
