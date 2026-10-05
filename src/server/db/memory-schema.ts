import type Database from 'better-sqlite3'

/** Shared by fresh installs and the append-only v51 upgrade. */
export function initMemorySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_scopes (
      id TEXT PRIMARY KEY,
      level TEXT NOT NULL CHECK (level IN ('global', 'project', 'workspace')),
      project_path TEXT,
      workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (level = 'global' AND project_path IS NULL AND workspace_id IS NULL) OR
        (level = 'project' AND project_path IS NOT NULL AND workspace_id IS NULL) OR
        (level = 'workspace' AND project_path IS NULL AND workspace_id IS NOT NULL)
      )
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_scopes_global
      ON memory_scopes(level) WHERE level = 'global';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_scopes_project
      ON memory_scopes(project_path) WHERE level = 'project';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_scopes_workspace
      ON memory_scopes(workspace_id) WHERE level = 'workspace';
    CREATE INDEX IF NOT EXISTS idx_memory_scopes_level_id
      ON memory_scopes(level, id);

    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL REFERENCES memory_scopes(id) ON DELETE CASCADE,
      memory_key TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'internal-agent', 'external-mcp')),
      source_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
      source_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
      source_engine TEXT,
      client_name TEXT,
      transport TEXT CHECK (transport IS NULL OR transport IN ('http', 'stdio')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (scope_id, memory_key),
      CHECK (
        (actor_kind = 'human' AND source_workspace_id IS NULL AND source_session_id IS NULL AND source_engine IS NULL AND client_name IS NULL AND transport IS NULL) OR
        (actor_kind = 'internal-agent' AND source_engine IN ('claude-code', 'codex') AND client_name IS NULL AND transport IS NULL) OR
        (actor_kind = 'external-mcp' AND source_workspace_id IS NULL AND source_session_id IS NULL AND source_engine IS NULL AND client_name IS NOT NULL AND transport IN ('http', 'stdio'))
      )
    );
    CREATE INDEX IF NOT EXISTS idx_memory_entries_scope_id
      ON memory_entries(scope_id, id);
    CREATE INDEX IF NOT EXISTS idx_memory_entries_scope_updated
      ON memory_entries(scope_id, updated_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS memory_proposals (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL REFERENCES memory_scopes(id) ON DELETE CASCADE,
      target_entry_id TEXT REFERENCES memory_entries(id) ON DELETE CASCADE,
      base_revision INTEGER,
      memory_key TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 0),
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'internal-agent', 'external-mcp')),
      source_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
      source_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
      source_engine TEXT,
      client_name TEXT,
      transport TEXT CHECK (transport IS NULL OR transport IN ('http', 'stdio')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((target_entry_id IS NULL AND base_revision IS NULL) OR (target_entry_id IS NOT NULL AND base_revision IS NOT NULL)),
      CHECK (
        (actor_kind = 'human' AND source_workspace_id IS NULL AND source_session_id IS NULL AND source_engine IS NULL AND client_name IS NULL AND transport IS NULL) OR
        (actor_kind = 'internal-agent' AND source_engine IN ('claude-code', 'codex') AND client_name IS NULL AND transport IS NULL) OR
        (actor_kind = 'external-mcp' AND source_workspace_id IS NULL AND source_session_id IS NULL AND source_engine IS NULL AND client_name IS NOT NULL AND transport IN ('http', 'stdio'))
      )
    );
    CREATE INDEX IF NOT EXISTS idx_memory_proposals_scope_id
      ON memory_proposals(scope_id, id);
    CREATE INDEX IF NOT EXISTS idx_memory_proposals_scope_created
      ON memory_proposals(scope_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_proposals_target
      ON memory_proposals(target_entry_id) WHERE target_entry_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS memory_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_id TEXT NOT NULL REFERENCES memory_scopes(id) ON DELETE CASCADE,
      operation TEXT NOT NULL CHECK (operation IN ('created', 'updated', 'deleted', 'proposed', 'approved', 'rejected', 'promoted', 'cleared', 'read')),
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'internal-agent', 'external-mcp')),
      source_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
      source_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
      source_engine TEXT,
      -- Preserve source project attribution when ON DELETE SET NULL clears workspace id.
      source_project_path TEXT,
      client_name TEXT,
      transport TEXT CHECK (transport IS NULL OR transport IN ('http', 'stdio')),
      entry_id TEXT,
      proposal_id TEXT,
      revision INTEGER,
      affected_entries INTEGER,
      affected_proposals INTEGER,
      created_at TEXT NOT NULL,
      CHECK (affected_entries IS NULL OR affected_entries >= 0),
      CHECK (affected_proposals IS NULL OR affected_proposals >= 0),
      CHECK (
        (actor_kind = 'human' AND source_workspace_id IS NULL AND source_session_id IS NULL AND source_engine IS NULL AND client_name IS NULL AND transport IS NULL) OR
        (actor_kind = 'internal-agent' AND source_engine IN ('claude-code', 'codex') AND client_name IS NULL AND transport IS NULL) OR
        (actor_kind = 'external-mcp' AND source_workspace_id IS NULL AND source_session_id IS NULL AND source_engine IS NULL AND client_name IS NOT NULL AND transport IN ('http', 'stdio'))
      )
    );
    CREATE INDEX IF NOT EXISTS idx_memory_operations_scope_id
      ON memory_operations(scope_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_operations_source_workspace_id
      ON memory_operations(source_workspace_id, id DESC);

    CREATE TABLE IF NOT EXISTS memory_contexts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      dispatch_id TEXT NOT NULL UNIQUE,
      budget_context_id TEXT REFERENCES memory_budget_contexts(id) ON DELETE SET NULL,
      budget_epoch INTEGER NOT NULL DEFAULT 0 CHECK (budget_epoch >= 0),
      engine TEXT NOT NULL CHECK (engine IN ('claude-code', 'codex')),
      state TEXT NOT NULL CHECK (state IN ('prepared', 'submitted', 'initialized', 'failed', 'unknown')),
      entry_revisions_json TEXT NOT NULL,
      scope_generations_json TEXT NOT NULL,
      omitted_count INTEGER NOT NULL DEFAULT 0 CHECK (omitted_count >= 0),
      estimated_tokens INTEGER NOT NULL DEFAULT 0 CHECK (estimated_tokens >= 0),
      payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK (payload_bytes >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_contexts_workspace_id
      ON memory_contexts(workspace_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_contexts_session_id
      ON memory_contexts(session_id, id DESC);

    -- conversation_key is a backend-owned opaque identity, persisted with each
    -- internal budget ledger. Reuse it for resumes; allocate a new key for a
    -- fresh native conversation, including when the provider ID is not known.
    CREATE TABLE IF NOT EXISTS memory_budget_contexts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('internal', 'external')),
      session_id TEXT REFERENCES agent_sessions(id) ON DELETE CASCADE,
      engine TEXT CHECK (engine IS NULL OR engine IN ('claude-code', 'codex')),
      conversation_key TEXT CHECK (conversation_key IS NULL OR length(trim(conversation_key)) > 0),
      native_conversation_id TEXT,
      external_context_id TEXT,
      epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
      cumulative_estimated_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cumulative_estimated_tokens >= 0),
      delivered_json TEXT NOT NULL DEFAULT '[]',
      client_name TEXT,
      transport TEXT CHECK (transport IS NULL OR transport IN ('http', 'stdio')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (kind = 'internal' AND session_id IS NOT NULL AND engine IS NOT NULL AND conversation_key IS NOT NULL AND external_context_id IS NULL AND client_name IS NULL AND transport IS NULL) OR
        (kind = 'external' AND session_id IS NULL AND engine IS NULL AND conversation_key IS NULL AND external_context_id IS NOT NULL AND client_name IS NOT NULL AND transport IN ('http', 'stdio'))
      )
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_budget_internal_conversation_epoch
      ON memory_budget_contexts(conversation_key, epoch) WHERE kind = 'internal';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_budget_external_context
      ON memory_budget_contexts(external_context_id) WHERE kind = 'external';
    CREATE INDEX IF NOT EXISTS idx_memory_budget_session_id
      ON memory_budget_contexts(session_id, id) WHERE session_id IS NOT NULL;
  `)
}

/** Apply the current memory schema to an upgraded database, including additive v51 columns. */
export function migrateMemorySchema(db: Database.Database): void {
  initMemorySchema(db)
  const contextColumns = db.prepare('PRAGMA table_info(memory_contexts)').all() as Array<{ name: string }>
  if (!contextColumns.some((column) => column.name === 'budget_context_id')) {
    db.exec(
      'ALTER TABLE memory_contexts ADD COLUMN budget_context_id TEXT REFERENCES memory_budget_contexts(id) ON DELETE SET NULL',
    )
  }
  if (!contextColumns.some((column) => column.name === 'budget_epoch')) {
    db.exec('ALTER TABLE memory_contexts ADD COLUMN budget_epoch INTEGER NOT NULL DEFAULT 0 CHECK (budget_epoch >= 0)')
  }
  const columns = db.prepare('PRAGMA table_info(memory_operations)').all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === 'source_project_path')) {
    db.exec('ALTER TABLE memory_operations ADD COLUMN source_project_path TEXT')
  }
}
