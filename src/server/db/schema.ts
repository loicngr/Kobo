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
      model TEXT NOT NULL DEFAULT 'claude-opus-4-8',
      brainstorm_model TEXT,
      reasoning_effort TEXT NOT NULL DEFAULT 'auto',
      permission_mode TEXT NOT NULL DEFAULT 'auto-accept',
      dev_server_status TEXT NOT NULL DEFAULT 'stopped',
      has_unread INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      favorited_at TEXT,
      pr_watch_disabled_at TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      engine TEXT NOT NULL DEFAULT 'claude-code',
      auto_loop INTEGER NOT NULL DEFAULT 0,
      auto_loop_ready INTEGER NOT NULL DEFAULT 0,
      auto_loop_session_mode TEXT NOT NULL DEFAULT 'per_task',
      no_progress_streak INTEGER NOT NULL DEFAULT 0,
      permission_profile TEXT NOT NULL DEFAULT 'bypass',
      agent_permission_mode TEXT NOT NULL DEFAULT 'bypass',
      description TEXT,
      agent_description TEXT,
      initial_prompt TEXT,
      pr_changes_dismissed_at TEXT,
      pr_ci_failure_dismissed_at TEXT,
      worktree_purged_at TEXT,
      worktree_purge_restore_data TEXT,
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
      engine TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      model TEXT,
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

    CREATE TABLE IF NOT EXISTS session_event_metrics (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      errors INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (workspace_id, session_id)
    );

    CREATE TRIGGER IF NOT EXISTS trg_ws_events_metrics_insert
    AFTER INSERT ON ws_events
    WHEN NEW.type = 'agent:event'
      AND NEW.session_id IS NOT NULL
      AND json_valid(NEW.payload)
      AND EXISTS (
        SELECT 1 FROM agent_sessions
        WHERE id = NEW.session_id AND workspace_id = NEW.workspace_id
      )
    BEGIN
      INSERT INTO session_event_metrics (
        workspace_id, session_id, tool_calls, errors, input_tokens, output_tokens
      ) VALUES (
        NEW.workspace_id,
        NEW.session_id,
        CASE WHEN json_extract(NEW.payload, '$.kind') = 'tool:call' THEN 1 ELSE 0 END,
        CASE
          WHEN json_extract(NEW.payload, '$.kind') = 'error'
            OR (json_extract(NEW.payload, '$.kind') = 'tool:result'
              AND json_extract(NEW.payload, '$.isError') = 1)
          THEN 1 ELSE 0
        END,
        CASE
          WHEN json_extract(NEW.payload, '$.kind') = 'usage'
            AND json_type(NEW.payload, '$.inputTokens') IN ('integer', 'real')
          THEN CAST(json_extract(NEW.payload, '$.inputTokens') AS INTEGER) ELSE 0
        END,
        CASE
          WHEN json_extract(NEW.payload, '$.kind') = 'usage'
            AND json_type(NEW.payload, '$.outputTokens') IN ('integer', 'real')
          THEN CAST(json_extract(NEW.payload, '$.outputTokens') AS INTEGER) ELSE 0
        END
      )
      ON CONFLICT(workspace_id, session_id) DO UPDATE SET
        tool_calls = tool_calls + excluded.tool_calls,
        errors = errors + excluded.errors,
        input_tokens = MAX(input_tokens, excluded.input_tokens),
        output_tokens = MAX(output_tokens, excluded.output_tokens);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_ws_events_metrics_delete
    AFTER DELETE ON ws_events
    WHEN OLD.type = 'agent:event' AND OLD.session_id IS NOT NULL
    BEGIN
      DELETE FROM session_event_metrics
      WHERE workspace_id = OLD.workspace_id AND session_id = OLD.session_id;

      INSERT INTO session_event_metrics (
        workspace_id, session_id, tool_calls, errors, input_tokens, output_tokens
      )
      SELECT
        e.workspace_id,
        e.session_id,
        SUM(CASE WHEN json_extract(e.payload, '$.kind') = 'tool:call' THEN 1 ELSE 0 END),
        SUM(CASE
          WHEN json_extract(e.payload, '$.kind') = 'error'
            OR (json_extract(e.payload, '$.kind') = 'tool:result'
              AND json_extract(e.payload, '$.isError') = 1)
          THEN 1 ELSE 0
        END),
        MAX(CASE
          WHEN json_extract(e.payload, '$.kind') = 'usage'
            AND json_type(e.payload, '$.inputTokens') IN ('integer', 'real')
          THEN CAST(json_extract(e.payload, '$.inputTokens') AS INTEGER) ELSE 0
        END),
        MAX(CASE
          WHEN json_extract(e.payload, '$.kind') = 'usage'
            AND json_type(e.payload, '$.outputTokens') IN ('integer', 'real')
          THEN CAST(json_extract(e.payload, '$.outputTokens') AS INTEGER) ELSE 0
        END)
      FROM ws_events e
      JOIN agent_sessions s ON s.id = e.session_id AND s.workspace_id = e.workspace_id
      WHERE e.workspace_id = OLD.workspace_id
        AND e.session_id = OLD.session_id
        AND e.type = 'agent:event'
        AND json_valid(e.payload)
      GROUP BY e.workspace_id, e.session_id;
    END;

    CREATE TABLE IF NOT EXISTS workspace_permission_rules (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      engine TEXT,
      tool_name TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('operation', 'tool')),
      fingerprint TEXT,
      display_label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_permission_rules_lookup
      ON workspace_permission_rules(workspace_id, engine, tool_name, scope, fingerprint);

    CREATE TABLE IF NOT EXISTS pending_wakeups (
      workspace_id     TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      target_at        TEXT NOT NULL,
      prompt           TEXT NOT NULL,
      reason           TEXT,
      created_at       TEXT NOT NULL,
      agent_session_id TEXT
    );

    CREATE TABLE IF NOT EXISTS pending_quota_backoffs (
      workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      target_at    TEXT NOT NULL,
      resets_at    TEXT,
      source       TEXT NOT NULL CHECK (source IN ('rate_limit_info', 'usage_api', 'fallback_ladder')),
      retry_count  INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_crons (
      id                TEXT PRIMARY KEY,
      workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      expression        TEXT NOT NULL,
      prompt            TEXT NOT NULL,
      label             TEXT,
      agent_session_id  TEXT,
      next_fire_at      TEXT NOT NULL,
      last_fired_at     TEXT,
      one_shot          INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pending_crons_workspace ON pending_crons(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_pending_crons_next_fire ON pending_crons(next_fire_at);

    CREATE TABLE IF NOT EXISTS usage_snapshots (
      provider_id   TEXT PRIMARY KEY,
      status        TEXT NOT NULL,
      error_message TEXT,
      buckets_json  TEXT NOT NULL,
      fetched_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_chat_history (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id  TEXT    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      message       TEXT    NOT NULL,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_workspace_id ON tasks(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_workspace_id ON agent_sessions(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_ws_events_workspace_id ON ws_events(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_ws_events_workspace_type_session
      ON ws_events(workspace_id, type, session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_ws_events_type_created
      ON ws_events(type, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_workspace_chat_history_workspace_id_id
      ON workspace_chat_history(workspace_id, id DESC);
  `)
}
