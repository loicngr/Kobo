import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { getMigrationHistory, migrations, runMigrations, SCHEMA_VERSION } from '../server/db/migrations.js'
import { initSchema } from '../server/db/schema.js'

describe('runMigrations(db)', () => {
  it('crée toutes les tables requises (fresh install)', () => {
    const db = new Database(':memory:')
    runMigrations(db)

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string
    }[]

    const tableNames = tables.map((t) => t.name)
    expect(tableNames).toContain('workspaces')
    expect(tableNames).toContain('tasks')
    expect(tableNames).toContain('agent_sessions')
    expect(tableNames).toContain('ws_events')
    expect(tableNames).toContain('schema_migrations')
    expect(tableNames).not.toContain('schema_version')
    db.close()
  })

  it('enregistre toutes les migrations dans schema_migrations (fresh install)', () => {
    const db = new Database(':memory:')
    runMigrations(db)

    const history = getMigrationHistory(db)
    // init-schema (v1) + all incremental migrations
    expect(history.length).toBe(1 + migrations.length)
    expect(history[0].version).toBe(1)
    expect(history[0].name).toBe('init-schema')
    expect(history[history.length - 1].version).toBe(SCHEMA_VERSION)
    db.close()
  })

  it('exporte SCHEMA_VERSION = 18', () => {
    expect(SCHEMA_VERSION).toBe(18)
  })

  it('migration v17 unifies legacy permission_mode + permission_profile into agent_permission_mode', () => {
    // Build a v16 database with the old schema and seed rows covering each
    // legacy combination so we can assert the unified column comes out right.
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE workspaces (
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
        model TEXT NOT NULL,
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
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE pending_wakeups (
        workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        target_at    TEXT NOT NULL,
        prompt       TEXT NOT NULL,
        reason       TEXT,
        created_at   TEXT NOT NULL
      );
    `)
    // Mark all migrations up to v16 as already applied.
    const now = '2025-01-01'
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(1, 'init-schema', now)
    for (const m of migrations) {
      if (m.version <= 16) {
        db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(m.version, m.name, now)
      }
    }
    // Seed rows covering every (permission_mode, permission_profile) combination.
    const insert = db.prepare(
      `INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, model, permission_mode, permission_profile, created_at, updated_at)
       VALUES (?, 'w', '/p', 'main', 'feat', 'claude-opus-4-7', ?, ?, ?, ?)`,
    )
    insert.run('plan-bypass', 'plan', 'bypass', now, now)
    insert.run('plan-strict', 'plan', 'strict', now, now)
    insert.run('auto-bypass', 'auto-accept', 'bypass', now, now)
    insert.run('auto-strict', 'auto-accept', 'strict', now, now)
    insert.run('auto-interactive', 'auto-accept', 'interactive', now, now)

    runMigrations(db)

    const rows = db.prepare('SELECT id, agent_permission_mode FROM workspaces ORDER BY id').all() as Array<{
      id: string
      agent_permission_mode: string
    }>
    const map = Object.fromEntries(rows.map((r) => [r.id, r.agent_permission_mode]))
    // 'plan' wins regardless of the profile.
    expect(map['plan-bypass']).toBe('plan')
    expect(map['plan-strict']).toBe('plan')
    // 'auto-accept' rows promote the profile.
    expect(map['auto-bypass']).toBe('bypass')
    expect(map['auto-strict']).toBe('strict')
    expect(map['auto-interactive']).toBe('interactive')

    // Idempotent: a second run preserves the data and stays at the latest version.
    runMigrations(db)
    const second = db.prepare('SELECT agent_permission_mode FROM workspaces WHERE id = ?').get('plan-bypass') as {
      agent_permission_mode: string
    }
    expect(second.agent_permission_mode).toBe('plan')
    db.close()
  })

  it('migre depuis la legacy schema_version table', () => {
    const db = new Database(':memory:')
    // Simulate a v1 database with old schema_version table
    db.exec(
      [
        'CREATE TABLE schema_version (version INTEGER NOT NULL)',
        'INSERT INTO schema_version (version) VALUES (1)',
        "CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, project_path TEXT NOT NULL, source_branch TEXT NOT NULL, working_branch TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'created', notion_url TEXT, notion_page_id TEXT, model TEXT NOT NULL DEFAULT 'claude-opus-4-6', dev_server_status TEXT NOT NULL DEFAULT 'stopped', archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
        "CREATE TABLE tasks (id TEXT PRIMARY KEY, workspace_id TEXT, title TEXT, status TEXT DEFAULT 'pending', is_acceptance_criterion INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT)",
        "CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, workspace_id TEXT, pid INTEGER, claude_session_id TEXT, status TEXT DEFAULT 'running', started_at TEXT, ended_at TEXT)",
        'CREATE TABLE ws_events (id TEXT PRIMARY KEY, workspace_id TEXT, type TEXT, payload TEXT, session_id TEXT, created_at TEXT)',
        "INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, created_at, updated_at) VALUES ('w1', 'test', '/tmp', 'main', 'feat', '2025-01-01', '2025-01-01')",
      ].join('; '),
    )

    runMigrations(db)

    // Legacy table should be dropped
    const hasLegacy = (
      db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='schema_version'").get() as {
        c: number
      }
    ).c
    expect(hasLegacy).toBe(0)

    // History should show init + applied migration
    const history = getMigrationHistory(db)
    expect(history.some((h) => h.version === 1 && h.name === 'init-schema')).toBe(true)
    expect(history.some((h) => h.version === 2 && h.name === 'add-permission-mode')).toBe(true)

    // Migration should have been applied
    const row = db.prepare('SELECT permission_mode FROM workspaces WHERE id = ?').get('w1') as {
      permission_mode: string
    }
    expect(row.permission_mode).toBe('auto-accept')
    db.close()
  })

  it('est idempotent (peut être appelé plusieurs fois)', () => {
    const db = new Database(':memory:')
    expect(() => {
      runMigrations(db)
      runMigrations(db)
      runMigrations(db)
    }).not.toThrow()

    // Should still have exactly the same number of records
    const history = getMigrationHistory(db)
    expect(history.length).toBe(1 + migrations.length)
    db.close()
  })

  it("n'applique pas une migration déjà présente", () => {
    const db = new Database(':memory:')
    runMigrations(db)

    const beforeCount = (
      db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table'").get() as { c: number }
    ).c

    runMigrations(db)

    const afterCount = (db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table'").get() as { c: number })
      .c

    expect(afterCount).toBe(beforeCount)
    db.close()
  })

  it('crée les index workspace_id après migration (fresh install)', () => {
    const db = new Database(':memory:')
    runMigrations(db)

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%_workspace_id'")
      .all() as { name: string }[]
    const indexNames = indexes.map((i) => i.name)

    expect(indexNames).toContain('idx_tasks_workspace_id')
    expect(indexNames).toContain('idx_agent_sessions_workspace_id')
    expect(indexNames).toContain('idx_ws_events_workspace_id')
    db.close()
  })

  it("crée les index workspace_id lors d'un upgrade v2 → v3", () => {
    const db = new Database(':memory:')
    // Simulate a v2 database (init + permission_mode migration already applied)
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version  INTEGER PRIMARY KEY,
        name     TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `)
    db.exec(`
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, project_path TEXT NOT NULL, source_branch TEXT NOT NULL, working_branch TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'created', notion_url TEXT, notion_page_id TEXT, model TEXT NOT NULL DEFAULT 'claude-opus-4-6', permission_mode TEXT NOT NULL DEFAULT 'auto-accept', dev_server_status TEXT NOT NULL DEFAULT 'stopped', archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', is_acceptance_criterion INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, pid INTEGER, claude_session_id TEXT, status TEXT NOT NULL DEFAULT 'running', started_at TEXT NOT NULL, ended_at TEXT);
      CREATE TABLE ws_events (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, type TEXT NOT NULL, payload TEXT NOT NULL, session_id TEXT, created_at TEXT NOT NULL);
    `)
    const now = new Date().toISOString()
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(1, 'init-schema', now)
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      2,
      'add-permission-mode',
      now,
    )

    // No indexes should exist yet
    const beforeIndexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%_workspace_id'")
      .all() as { name: string }[]
    expect(beforeIndexes.length).toBe(0)

    runMigrations(db)

    // Indexes should now exist
    const afterIndexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%_workspace_id'")
      .all() as { name: string }[]
    const indexNames = afterIndexes.map((i) => i.name)

    expect(indexNames).toContain('idx_tasks_workspace_id')
    expect(indexNames).toContain('idx_agent_sessions_workspace_id')
    expect(indexNames).toContain('idx_ws_events_workspace_id')

    // Migration should be recorded
    const history = getMigrationHistory(db)
    expect(history.some((h) => h.version === 3 && h.name === 'add-workspace-id-indexes')).toBe(true)
    db.close()
  })

  it("ajoute la colonne has_unread lors d'un upgrade v3 -> v4", () => {
    const db = new Database(':memory:')
    // Simulate a v3 database
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version  INTEGER PRIMARY KEY,
        name     TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `)
    db.exec(`
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, project_path TEXT NOT NULL, source_branch TEXT NOT NULL, working_branch TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'created', notion_url TEXT, notion_page_id TEXT, model TEXT NOT NULL DEFAULT 'claude-opus-4-6', permission_mode TEXT NOT NULL DEFAULT 'auto-accept', dev_server_status TEXT NOT NULL DEFAULT 'stopped', archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', is_acceptance_criterion INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, pid INTEGER, claude_session_id TEXT, status TEXT NOT NULL DEFAULT 'running', started_at TEXT NOT NULL, ended_at TEXT);
      CREATE TABLE ws_events (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, type TEXT NOT NULL, payload TEXT NOT NULL, session_id TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_tasks_workspace_id ON tasks(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_workspace_id ON agent_sessions(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_ws_events_workspace_id ON ws_events(workspace_id);
    `)
    const now = new Date().toISOString()
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(1, 'init-schema', now)
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      2,
      'add-permission-mode',
      now,
    )
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      3,
      'add-workspace-id-indexes',
      now,
    )

    // Insert a workspace before migration
    db.prepare(
      "INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, created_at, updated_at) VALUES ('w1', 'test', '/tmp', 'main', 'feat', ?, ?)",
    ).run(now, now)

    runMigrations(db)

    // has_unread column should exist with default value 0
    const row = db.prepare('SELECT has_unread FROM workspaces WHERE id = ?').get('w1') as { has_unread: number }
    expect(row.has_unread).toBe(0)

    // Migration should be recorded
    const history = getMigrationHistory(db)
    expect(history.some((h) => h.version === 4 && h.name === 'add-has-unread')).toBe(true)
    db.close()
  })

  it('getMigrationHistory retourne un tableau vide sur une DB sans la table', () => {
    const db = new Database(':memory:')
    const history = getMigrationHistory(db)
    expect(history).toEqual([])
    db.close()
  })

  it('migration v5: ajoute la colonne name à agent_sessions', () => {
    const db = new Database(':memory:')
    // Simulate a v4 database (all migrations up to v4 applied manually)
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, project_path TEXT NOT NULL,
        source_branch TEXT NOT NULL, working_branch TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'created',
        notion_url TEXT, notion_page_id TEXT, model TEXT NOT NULL DEFAULT 'claude-opus-4-6',
        permission_mode TEXT NOT NULL DEFAULT 'auto-accept',
        dev_server_status TEXT NOT NULL DEFAULT 'stopped', archived_at TEXT, has_unread INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL
        REFERENCES workspaces(id) ON DELETE CASCADE, pid INTEGER, claude_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'running', started_at TEXT NOT NULL, ended_at TEXT);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', is_acceptance_criterion INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE ws_events (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, type TEXT NOT NULL,
        payload TEXT NOT NULL, session_id TEXT, created_at TEXT NOT NULL);
      INSERT INTO schema_migrations (version, name, applied_at) VALUES
        (1, 'init-schema', '2025-01-01'),
        (2, 'add-permission-mode', '2025-01-01'),
        (3, 'add-workspace-id-indexes', '2025-01-01'),
        (4, 'add-has-unread', '2025-01-01');
    `)

    runMigrations(db)

    const cols = db.prepare('PRAGMA table_info(agent_sessions)').all() as { name: string }[]
    expect(cols.map((c) => c.name)).toContain('name')

    const history = getMigrationHistory(db)
    expect(history.find((h) => h.version === 5)).toBeTruthy()
    db.close()
  })

  it('fresh install v5: agent_sessions a la colonne name', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const cols = db.prepare('PRAGMA table_info(agent_sessions)').all() as { name: string }[]
    expect(cols.map((c) => c.name)).toContain('name')
    db.close()
  })

  it('migration v6: backfille ws_events.session_id depuis claude_session_id vers agent_sessions.id', () => {
    const db = new Database(':memory:')
    // Simulate a v5 database with existing ws_events rows tagged by claude_session_id
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, project_path TEXT NOT NULL,
        source_branch TEXT NOT NULL, working_branch TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'created',
        notion_url TEXT, notion_page_id TEXT, model TEXT NOT NULL DEFAULT 'claude-opus-4-6',
        permission_mode TEXT NOT NULL DEFAULT 'auto-accept',
        dev_server_status TEXT NOT NULL DEFAULT 'stopped', archived_at TEXT, has_unread INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL
        REFERENCES workspaces(id) ON DELETE CASCADE, pid INTEGER, claude_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'running', started_at TEXT NOT NULL, ended_at TEXT, name TEXT);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', is_acceptance_criterion INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE ws_events (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, type TEXT NOT NULL,
        payload TEXT NOT NULL, session_id TEXT, created_at TEXT NOT NULL);
      INSERT INTO schema_migrations (version, name, applied_at) VALUES
        (1, 'init-schema', '2025-01-01'),
        (2, 'add-permission-mode', '2025-01-01'),
        (3, 'add-workspace-id-indexes', '2025-01-01'),
        (4, 'add-has-unread', '2025-01-01'),
        (5, 'add-agent-session-name', '2025-01-01');
      INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, created_at, updated_at)
        VALUES ('w1', 'test', '/tmp', 'main', 'feat', '2025-01-01', '2025-01-01');
      INSERT INTO agent_sessions (id, workspace_id, pid, claude_session_id, status, started_at)
        VALUES ('sess-internal-1', 'w1', 100, 'claude-uuid-1', 'completed', '2025-01-01'),
               ('sess-internal-2', 'w1', 101, 'claude-uuid-2', 'completed', '2025-01-02');
      INSERT INTO ws_events (id, workspace_id, type, payload, session_id, created_at) VALUES
        ('e1', 'w1', 'agent:output', '{}', 'claude-uuid-1', '2025-01-01'),
        ('e2', 'w1', 'agent:output', '{}', 'claude-uuid-1', '2025-01-01'),
        ('e3', 'w1', 'agent:output', '{}', 'claude-uuid-2', '2025-01-02'),
        ('e4', 'w1', 'agent:output', '{}', NULL, '2025-01-02'),
        ('e5', 'w1', 'agent:output', '{}', 'unknown-uuid', '2025-01-02');
    `)

    runMigrations(db)

    // Events tagged with known claude_session_id should be rewritten to agent_sessions.id
    const events = db.prepare('SELECT id, session_id FROM ws_events ORDER BY id').all() as {
      id: string
      session_id: string | null
    }[]
    expect(events.find((e) => e.id === 'e1')?.session_id).toBe('sess-internal-1')
    expect(events.find((e) => e.id === 'e2')?.session_id).toBe('sess-internal-1')
    expect(events.find((e) => e.id === 'e3')?.session_id).toBe('sess-internal-2')
    // NULL stays NULL
    expect(events.find((e) => e.id === 'e4')?.session_id).toBe(null)
    // Unknown claude_session_id stays untouched (no matching agent_sessions row)
    expect(events.find((e) => e.id === 'e5')?.session_id).toBe('unknown-uuid')

    const history = getMigrationHistory(db)
    expect(history.find((h) => h.version === 6)).toBeTruthy()
    db.close()
  })

  it('migration v6 est idempotente (un second runMigrations ne re-modifie rien)', () => {
    const db = new Database(':memory:')
    runMigrations(db)

    // Insert legacy data AFTER the initial migration — this mimics events
    // that could have been written by an older backend still running
    // against the upgraded schema.
    db.exec(`
      INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, created_at, updated_at)
        VALUES ('w1', 'test', '/tmp', 'main', 'feat', '2025-01-01', '2025-01-01');
      INSERT INTO agent_sessions (id, workspace_id, pid, engine_session_id, status, started_at)
        VALUES ('sess-1', 'w1', 100, 'claude-legacy', 'completed', '2025-01-01');
      INSERT INTO ws_events (id, workspace_id, type, payload, session_id, created_at)
        VALUES ('e1', 'w1', 'agent:output', '{}', 'claude-legacy', '2025-01-01');
    `)

    // Run migrations a second time — schema_migrations already has v6, so the
    // backfill should NOT run again. The legacy row must remain unchanged.
    runMigrations(db)

    const row = db.prepare('SELECT session_id FROM ws_events WHERE id = ?').get('e1') as {
      session_id: string | null
    }
    // v6 was already marked as applied, so the second run is a no-op: the legacy
    // tag is still present. This protects against accidental double-execution.
    expect(row.session_id).toBe('claude-legacy')

    // And the history should still contain v6 exactly once.
    const history = getMigrationHistory(db)
    const v6Entries = history.filter((h) => h.version === 6)
    expect(v6Entries.length).toBe(1)

    db.close()
  })

  it('v8: adds favorited_at column to workspaces (nullable, defaults to NULL)', () => {
    const db = new Database(':memory:')
    // Simulate a v7 database
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, project_path TEXT NOT NULL,
        source_branch TEXT NOT NULL, working_branch TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'created',
        notion_url TEXT, notion_page_id TEXT, model TEXT NOT NULL DEFAULT 'claude-opus-4-7',
        reasoning_effort TEXT NOT NULL DEFAULT 'auto',
        permission_mode TEXT NOT NULL DEFAULT 'auto-accept',
        dev_server_status TEXT NOT NULL DEFAULT 'stopped', has_unread INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', is_acceptance_criterion INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL
        REFERENCES workspaces(id) ON DELETE CASCADE, pid INTEGER, claude_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'running', started_at TEXT NOT NULL, ended_at TEXT, name TEXT);
      CREATE TABLE ws_events (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, type TEXT NOT NULL,
        payload TEXT NOT NULL, session_id TEXT, created_at TEXT NOT NULL);
      INSERT INTO schema_migrations (version, name, applied_at) VALUES
        (1, 'init-schema', '2025-01-01'),
        (2, 'add-permission-mode', '2025-01-01'),
        (3, 'add-workspace-id-indexes', '2025-01-01'),
        (4, 'add-has-unread', '2025-01-01'),
        (5, 'add-agent-session-name', '2025-01-01'),
        (6, 'backfill-ws-events-session-id', '2025-01-01'),
        (7, 'add-reasoning-effort', '2025-01-01');
    `)

    // Insert a workspace before migration
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, created_at, updated_at) VALUES ('w1', 'test', '/tmp', 'main', 'feat', ?, ?)",
    ).run(now, now)

    runMigrations(db)

    // favorited_at column should exist and be nullable
    const cols = db.prepare('PRAGMA table_info(workspaces)').all() as {
      name: string
      notnull: number
    }[]
    const favoritedAtCol = cols.find((c) => c.name === 'favorited_at')
    expect(favoritedAtCol).toBeDefined()
    expect(favoritedAtCol?.notnull).toBe(0)

    // Existing row should have favorited_at = NULL
    const row = db.prepare('SELECT favorited_at FROM workspaces WHERE id = ?').get('w1') as {
      favorited_at: string | null
    }
    expect(row.favorited_at).toBeNull()

    // Migration should be recorded
    const history = getMigrationHistory(db)
    expect(history.find((h) => h.version === 8 && h.name === 'add-workspace-favorited-at')).toBeTruthy()

    db.close()
  })

  it('v8: fresh install matches upgraded install (identical table_info)', () => {
    // Fresh install DB
    const freshDb = new Database(':memory:')
    runMigrations(freshDb)

    // Upgraded from v7 DB
    const upgradedDb = new Database(':memory:')
    upgradedDb.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, project_path TEXT NOT NULL,
        source_branch TEXT NOT NULL, working_branch TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'created',
        notion_url TEXT, notion_page_id TEXT, model TEXT NOT NULL DEFAULT 'claude-opus-4-7',
        reasoning_effort TEXT NOT NULL DEFAULT 'auto',
        permission_mode TEXT NOT NULL DEFAULT 'auto-accept',
        dev_server_status TEXT NOT NULL DEFAULT 'stopped', has_unread INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', is_acceptance_criterion INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL
        REFERENCES workspaces(id) ON DELETE CASCADE, pid INTEGER, claude_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'running', started_at TEXT NOT NULL, ended_at TEXT, name TEXT);
      CREATE TABLE ws_events (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, type TEXT NOT NULL,
        payload TEXT NOT NULL, session_id TEXT, created_at TEXT NOT NULL);
      INSERT INTO schema_migrations (version, name, applied_at) VALUES
        (1, 'init-schema', '2025-01-01'),
        (2, 'add-permission-mode', '2025-01-01'),
        (3, 'add-workspace-id-indexes', '2025-01-01'),
        (4, 'add-has-unread', '2025-01-01'),
        (5, 'add-agent-session-name', '2025-01-01'),
        (6, 'backfill-ws-events-session-id', '2025-01-01'),
        (7, 'add-reasoning-effort', '2025-01-01');
    `)
    runMigrations(upgradedDb)

    const freshCols = (freshDb.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[])
      .map((c) => c.name)
      .sort()
    const upgradedCols = (upgradedDb.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[])
      .map((c) => c.name)
      .sort()

    expect(freshCols).toEqual(upgradedCols)
    expect(freshCols).toContain('favorited_at')

    freshDb.close()
    upgradedDb.close()
  })

  it('v10: adds engine column to workspaces and renames claude_session_id → engine_session_id without data loss', () => {
    const db = new Database(':memory:')
    // Simulate a v9 database (all migrations up to v9 applied manually)
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, project_path TEXT NOT NULL,
        source_branch TEXT NOT NULL, working_branch TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'created',
        notion_url TEXT, notion_page_id TEXT, model TEXT NOT NULL DEFAULT 'claude-opus-4-7',
        reasoning_effort TEXT NOT NULL DEFAULT 'auto',
        permission_mode TEXT NOT NULL DEFAULT 'auto-accept',
        dev_server_status TEXT NOT NULL DEFAULT 'stopped', has_unread INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT, favorited_at TEXT, tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', is_acceptance_criterion INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL
        REFERENCES workspaces(id) ON DELETE CASCADE, pid INTEGER, claude_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'running', started_at TEXT NOT NULL, ended_at TEXT, name TEXT);
      CREATE TABLE ws_events (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, type TEXT NOT NULL,
        payload TEXT NOT NULL, session_id TEXT, created_at TEXT NOT NULL);
      INSERT INTO schema_migrations (version, name, applied_at) VALUES
        (1, 'init-schema', '2025-01-01'),
        (2, 'add-permission-mode', '2025-01-01'),
        (3, 'add-workspace-id-indexes', '2025-01-01'),
        (4, 'add-has-unread', '2025-01-01'),
        (5, 'add-agent-session-name', '2025-01-01'),
        (6, 'backfill-ws-events-session-id', '2025-01-01'),
        (7, 'add-reasoning-effort', '2025-01-01'),
        (8, 'add-workspace-favorited-at', '2025-01-01'),
        (9, 'add-workspace-tags', '2025-01-01');
      INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, created_at, updated_at)
        VALUES ('w1', 'existing', '/tmp', 'main', 'feat', '2025-01-01', '2025-01-01');
      INSERT INTO agent_sessions (id, workspace_id, pid, claude_session_id, status, started_at)
        VALUES ('s1', 'w1', 123, 'claude-uuid-preserved', 'completed', '2025-01-01');
    `)

    runMigrations(db)

    // Migration should be recorded
    const history = getMigrationHistory(db)
    expect(history.find((h) => h.version === 10 && h.name === 'agent-engine-abstraction')).toBeTruthy()

    // workspaces.engine column should exist with default 'claude-code'
    const wsCols = db.prepare('PRAGMA table_info(workspaces)').all() as { name: string; dflt_value: string | null }[]
    const engineCol = wsCols.find((c) => c.name === 'engine')
    expect(engineCol).toBeDefined()

    // Existing workspace row should have engine = 'claude-code'
    const wsRow = db.prepare('SELECT engine FROM workspaces WHERE id = ?').get('w1') as { engine: string }
    expect(wsRow.engine).toBe('claude-code')

    // agent_sessions column should be renamed
    const sessCols = (db.prepare('PRAGMA table_info(agent_sessions)').all() as { name: string }[]).map((c) => c.name)
    expect(sessCols).toContain('engine_session_id')
    expect(sessCols).not.toContain('claude_session_id')

    // Existing session data should be preserved under the new column name
    const sessRow = db.prepare('SELECT engine_session_id FROM agent_sessions WHERE id = ?').get('s1') as {
      engine_session_id: string
    }
    expect(sessRow.engine_session_id).toBe('claude-uuid-preserved')

    db.close()
  })

  it('v10: fresh install matches upgraded install (identical table_info)', () => {
    // Fresh install DB
    const freshDb = new Database(':memory:')
    runMigrations(freshDb)

    // Upgraded from v9 DB
    const upgradedDb = new Database(':memory:')
    upgradedDb.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, project_path TEXT NOT NULL,
        source_branch TEXT NOT NULL, working_branch TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'created',
        notion_url TEXT, notion_page_id TEXT, model TEXT NOT NULL DEFAULT 'claude-opus-4-7',
        reasoning_effort TEXT NOT NULL DEFAULT 'auto',
        permission_mode TEXT NOT NULL DEFAULT 'auto-accept',
        dev_server_status TEXT NOT NULL DEFAULT 'stopped', has_unread INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT, favorited_at TEXT, tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', is_acceptance_criterion INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL
        REFERENCES workspaces(id) ON DELETE CASCADE, pid INTEGER, claude_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'running', started_at TEXT NOT NULL, ended_at TEXT, name TEXT);
      CREATE TABLE ws_events (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, type TEXT NOT NULL,
        payload TEXT NOT NULL, session_id TEXT, created_at TEXT NOT NULL);
      INSERT INTO schema_migrations (version, name, applied_at) VALUES
        (1, 'init-schema', '2025-01-01'),
        (2, 'add-permission-mode', '2025-01-01'),
        (3, 'add-workspace-id-indexes', '2025-01-01'),
        (4, 'add-has-unread', '2025-01-01'),
        (5, 'add-agent-session-name', '2025-01-01'),
        (6, 'backfill-ws-events-session-id', '2025-01-01'),
        (7, 'add-reasoning-effort', '2025-01-01'),
        (8, 'add-workspace-favorited-at', '2025-01-01'),
        (9, 'add-workspace-tags', '2025-01-01');
    `)
    runMigrations(upgradedDb)

    const freshWsCols = (freshDb.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[])
      .map((c) => c.name)
      .sort()
    const upgradedWsCols = (upgradedDb.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[])
      .map((c) => c.name)
      .sort()
    expect(freshWsCols).toEqual(upgradedWsCols)
    expect(freshWsCols).toContain('engine')

    const freshSessCols = (freshDb.prepare('PRAGMA table_info(agent_sessions)').all() as { name: string }[])
      .map((c) => c.name)
      .sort()
    const upgradedSessCols = (upgradedDb.prepare('PRAGMA table_info(agent_sessions)').all() as { name: string }[])
      .map((c) => c.name)
      .sort()
    expect(freshSessCols).toEqual(upgradedSessCols)
    expect(freshSessCols).toContain('engine_session_id')
    expect(freshSessCols).not.toContain('claude_session_id')

    freshDb.close()
    upgradedDb.close()
  })

  it("ajoute la colonne sentry_url lors d'un upgrade v13 -> v14", () => {
    const db = new Database(':memory:')
    // Simulate a real v13 schema: run all migrations, then unwind the v14
    // history row + drop the column. SQLite's DROP COLUMN (3.35+) lets us
    // do this without rebuilding the table by hand.
    runMigrations(db)
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(14)
    db.prepare('ALTER TABLE workspaces DROP COLUMN sentry_url').run()

    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, notion_url, created_at, updated_at) VALUES ('w1', 'preexisting', '/tmp', 'main', 'feat', 'https://www.notion.so/abc-1234567890abcdef1234567890abcd', ?, ?)",
    ).run(now, now)

    runMigrations(db)

    const row = db.prepare('SELECT sentry_url, notion_url FROM workspaces WHERE id = ?').get('w1') as {
      sentry_url: string | null
      notion_url: string | null
    }
    expect(row.sentry_url).toBeNull()
    expect(row.notion_url).toBe('https://www.notion.so/abc-1234567890abcdef1234567890abcd')

    const history = getMigrationHistory(db)
    expect(history.some((h) => h.version === 14 && h.name === 'add-workspace-sentry-url')).toBe(true)
    db.close()
  })

  it('expose la colonne sentry_url sur un fresh install', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const cols = db.prepare("PRAGMA table_info('workspaces')").all() as Array<{
      name: string
      type: string
      notnull: number
      dflt_value: string | null
    }>
    const sentryCol = cols.find((c) => c.name === 'sentry_url')
    expect(sentryCol).toBeDefined()
    expect(sentryCol?.type).toBe('TEXT')
    expect(sentryCol?.notnull).toBe(0)
    db.close()
  })

  it("ajoute les colonnes worktree_path et worktree_owned lors d'un upgrade v14 -> v15", () => {
    const db = new Database(':memory:')
    // Simulate a v14 schema by running all migrations then unwinding v15.
    runMigrations(db)
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(15)
    db.prepare('ALTER TABLE workspaces DROP COLUMN worktree_path').run()
    db.prepare('ALTER TABLE workspaces DROP COLUMN worktree_owned').run()

    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, created_at, updated_at) VALUES ('w1', 'pre', '/tmp/proj', 'main', 'feature/foo', ?, ?)",
    ).run(now, now)

    runMigrations(db)

    const row = db.prepare('SELECT worktree_path, worktree_owned FROM workspaces WHERE id = ?').get('w1') as {
      worktree_path: string
      worktree_owned: number
    }
    expect(row.worktree_path).toBe('/tmp/proj/.worktrees/feature/foo')
    expect(row.worktree_owned).toBe(1)

    const history = getMigrationHistory(db)
    expect(history.some((h) => h.version === 15 && h.name === 'add-workspace-worktree-path')).toBe(true)
    db.close()
  })

  it('expose les colonnes worktree_path et worktree_owned sur un fresh install', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const cols = db.prepare("PRAGMA table_info('workspaces')").all() as Array<{
      name: string
      type: string
      notnull: number
      dflt_value: string | null
    }>
    const wtPath = cols.find((c) => c.name === 'worktree_path')
    const wtOwned = cols.find((c) => c.name === 'worktree_owned')
    expect(wtPath).toBeDefined()
    expect(wtPath?.type).toBe('TEXT')
    expect(wtOwned).toBeDefined()
    expect(wtOwned?.type).toBe('INTEGER')
    expect(wtOwned?.notnull).toBe(1)
    db.close()
  })
})

describe('migration v11: add-pending-wakeups-table', () => {
  it('adds pending_wakeups table with expected columns after runMigrations', () => {
    const db = new Database(':memory:')
    runMigrations(db)

    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_wakeups'").get()
    expect(table).toBeTruthy()

    const cols = db.prepare('PRAGMA table_info(pending_wakeups)').all() as Array<{
      name: string
      pk: number
    }>
    expect(cols.map((c) => c.name).sort()).toEqual(
      ['agent_session_id', 'created_at', 'prompt', 'reason', 'target_at', 'workspace_id'].sort(),
    )
    const pk = cols.find((c) => c.pk === 1)
    expect(pk?.name).toBe('workspace_id')
    db.close()
  })

  it('fresh install via initSchema produces the same pending_wakeups shape as runMigrations', () => {
    const freshDb = new Database(':memory:')
    initSchema(freshDb)
    const freshCols = freshDb.prepare('PRAGMA table_info(pending_wakeups)').all()

    const upgradedDb = new Database(':memory:')
    runMigrations(upgradedDb)
    const upgradedCols = upgradedDb.prepare('PRAGMA table_info(pending_wakeups)').all()

    expect(freshCols).toEqual(upgradedCols)
    freshDb.close()
    upgradedDb.close()
  })

  it('v10 → v11 upgrade preserves existing workspace data', () => {
    const db = new Database(':memory:')
    // Seed via runMigrations up through v10, then simulate an existing row
    runMigrations(db)
    db.prepare(
      `INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('w1', 'legacy', '/tmp/p', 'main', 'feat', '2025-01-01', '2025-01-01')

    // Verify the workspace row survived and pending_wakeups is empty.
    const ws = db.prepare('SELECT id, name FROM workspaces WHERE id = ?').get('w1') as
      | { id: string; name: string }
      | undefined
    expect(ws).toEqual({ id: 'w1', name: 'legacy' })

    const countRow = db.prepare('SELECT COUNT(*) as c FROM pending_wakeups').get() as { c: number }
    expect(countRow.c).toBe(0)
    db.close()
  })
})

describe('migration v12: add-auto-loop-columns', () => {
  it('adds 3 columns to workspaces with correct defaults', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const cols = db.prepare('PRAGMA table_info(workspaces)').all() as Array<{
      name: string
      dflt_value: string | null
    }>
    const names = cols.map((c) => c.name)
    expect(names).toContain('auto_loop')
    expect(names).toContain('auto_loop_ready')
    expect(names).toContain('no_progress_streak')
    expect(cols.find((c) => c.name === 'auto_loop')?.dflt_value).toBe('0')
    expect(cols.find((c) => c.name === 'auto_loop_ready')?.dflt_value).toBe('0')
    expect(cols.find((c) => c.name === 'no_progress_streak')?.dflt_value).toBe('0')
    db.close()
  })

  it('fresh install via initSchema produces the same 3 columns', () => {
    const freshDb = new Database(':memory:')
    initSchema(freshDb)
    const upgradedDb = new Database(':memory:')
    runMigrations(upgradedDb)
    const freshCols = (freshDb.prepare('PRAGMA table_info(workspaces)').all() as Array<{ name: string }>)
      .map((c) => c.name)
      .sort()
    const upgradedCols = (upgradedDb.prepare('PRAGMA table_info(workspaces)').all() as Array<{ name: string }>)
      .map((c) => c.name)
      .sort()
    expect(freshCols).toEqual(upgradedCols)
    expect(freshCols).toContain('auto_loop')
    freshDb.close()
    upgradedDb.close()
  })

  // Per CLAUDE.md migration discipline: test the upgrade-with-data path,
  // not just the fresh install. A workspace seeded at v11 must survive the
  // v12 migration with its data intact and the 3 new columns defaulted to 0.
  it('v11 → v12 upgrade preserves existing workspace data', () => {
    const db = new Database(':memory:')
    runMigrations(db)

    db.prepare(
      `INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('w1', 'legacy', '/tmp/p', 'main', 'feat', '2025-01-01', '2025-01-01')

    const ws = db
      .prepare('SELECT id, name, auto_loop, auto_loop_ready, no_progress_streak FROM workspaces WHERE id = ?')
      .get('w1') as
      | {
          id: string
          name: string
          auto_loop: number
          auto_loop_ready: number
          no_progress_streak: number
        }
      | undefined

    expect(ws).toEqual({
      id: 'w1',
      name: 'legacy',
      auto_loop: 0,
      auto_loop_ready: 0,
      no_progress_streak: 0,
    })
    db.close()
  })

  // Migration v13: adds `permission_profile` so a user can switch a workspace
  // to strict mode (respect the project's .claude/settings.json allow/deny
  // list) instead of the --dangerously-skip-permissions bypass default.
  it('v13 upgrade: workspaces gain permission_profile column defaulted to bypass', () => {
    const db = new Database(':memory:')
    runMigrations(db)

    db.prepare(
      `INSERT INTO workspaces (id, name, project_path, source_branch, working_branch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('w2', 'legacy-v13', '/tmp/p', 'main', 'feat', '2025-01-01', '2025-01-01')

    const ws = db.prepare('SELECT id, permission_profile FROM workspaces WHERE id = ?').get('w2') as
      | { id: string; permission_profile: string }
      | undefined

    expect(ws).toEqual({ id: 'w2', permission_profile: 'bypass' })
    db.close()
  })
})

describe('usage_snapshots table', () => {
  it('is created by runMigrations on a fresh install', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const cols = db.prepare('PRAGMA table_info(usage_snapshots)').all() as Array<{ name: string }>
    const names = cols.map((c) => c.name).sort()
    expect(names).toEqual(['buckets_json', 'error_message', 'fetched_at', 'provider_id', 'status'])
    db.close()
  })

  it('is created when applying migration v16 on a database that already has versions 1..15', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(16)
    db.prepare('DROP TABLE usage_snapshots').run()

    runMigrations(db)

    const cols = db.prepare('PRAGMA table_info(usage_snapshots)').all() as Array<{ name: string }>
    expect(cols.length).toBe(5)
    const versions = (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (r) => r.version,
    )
    expect(versions).toContain(16)
    db.close()
  })
})

describe('migration v18: add-pending-wakeup-agent-session-id', () => {
  it('adds the agent_session_id column to pending_wakeups (nullable)', () => {
    const db = new Database(':memory:')
    runMigrations(db)

    const cols = db.prepare('PRAGMA table_info(pending_wakeups)').all() as Array<{
      name: string
      notnull: number
    }>
    const sessionCol = cols.find((c) => c.name === 'agent_session_id')
    expect(sessionCol).toBeDefined()
    expect(sessionCol?.notnull).toBe(0)
    db.close()
  })

  it('preserves existing pending_wakeups rows when upgrading from v17', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        project_path TEXT NOT NULL,
        source_branch TEXT NOT NULL,
        working_branch TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'created',
        model TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE pending_wakeups (
        workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        target_at    TEXT NOT NULL,
        prompt       TEXT NOT NULL,
        reason       TEXT,
        created_at   TEXT NOT NULL
      );
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
    `)
    const now = '2025-01-01'
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(1, 'init-schema', now)
    for (const m of migrations) {
      if (m.version <= 17) {
        db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(m.version, m.name, now)
      }
    }
    db.prepare("INSERT INTO workspaces VALUES ('w1', 'W', '/p', 'main', 'feat', 'idle', 'auto', ?, ?)").run(now, now)
    db.prepare('INSERT INTO pending_wakeups VALUES (?, ?, ?, ?, ?)').run('w1', now, 'resume', null, now)

    runMigrations(db)

    const row = db.prepare('SELECT * FROM pending_wakeups WHERE workspace_id = ?').get('w1') as {
      workspace_id: string
      prompt: string
      agent_session_id: string | null
    }
    expect(row.workspace_id).toBe('w1')
    expect(row.prompt).toBe('resume')
    expect(row.agent_session_id).toBeNull()
    db.close()
  })
})
