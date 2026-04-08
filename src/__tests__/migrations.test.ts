import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { getMigrationHistory, migrations, runMigrations, SCHEMA_VERSION } from '../server/db/migrations.js'

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

  it('exporte SCHEMA_VERSION = 4', () => {
    expect(SCHEMA_VERSION).toBe(4)
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
})
