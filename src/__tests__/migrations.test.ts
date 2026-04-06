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

  it('exporte SCHEMA_VERSION = 2', () => {
    expect(SCHEMA_VERSION).toBe(2)
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

  it('getMigrationHistory retourne un tableau vide sur une DB sans la table', () => {
    const db = new Database(':memory:')
    const history = getMigrationHistory(db)
    expect(history).toEqual([])
    db.close()
  })
})
