import type Database from 'better-sqlite3'
import { initSchema } from './schema.js'

// ── Migration registry ────────────────────────────────────────────────────────
// Each entry describes a single schema upgrade step.
// Append-only — never edit or reorder shipped entries.

/** Describes a single incremental schema upgrade step. Append-only -- never edit shipped entries. */
export interface Migration {
  version: number
  name: string
  migrate: (db: Database.Database) => void
}

/** Ordered registry of all schema migrations. Append new entries at the end. */
export const migrations: Migration[] = [
  {
    version: 2,
    name: 'add-permission-mode',
    migrate: (db) => {
      db.exec("ALTER TABLE workspaces ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'auto-accept'")
    },
  },
  {
    version: 3,
    name: 'add-workspace-id-indexes',
    migrate: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tasks_workspace_id ON tasks(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_agent_sessions_workspace_id ON agent_sessions(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_ws_events_workspace_id ON ws_events(workspace_id);
      `)
    },
  },
  {
    version: 4,
    name: 'add-has-unread',
    migrate: (db) => {
      db.prepare('ALTER TABLE workspaces ADD COLUMN has_unread INTEGER NOT NULL DEFAULT 0').run()
    },
  },
]

/** Current schema version — always equals the highest migration version. */
export const SCHEMA_VERSION = migrations.length > 0 ? migrations[migrations.length - 1].version : 1

// ── Runner ────────────────────────────────────────────────────────────────────

/** Row shape in the schema_migrations history table. */
export interface MigrationRecord {
  version: number
  name: string
  applied_at: string
}

/** Apply all pending migrations sequentially, or bootstrap a fresh database via initSchema. */
export function runMigrations(db: Database.Database): void {
  // Create the history table (replaces the old single-row schema_version table).
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version  INTEGER PRIMARY KEY,
      name     TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `)

  // ── Backward compat: migrate from legacy schema_version table ──────────────
  const hasLegacy =
    (
      db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='schema_version'").get() as {
        c: number
      }
    ).c > 0

  if (hasLegacy) {
    const legacyRow = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined
    const legacyVersion = legacyRow?.version ?? 0

    // Back-fill history for all migrations that were already applied under the old system.
    if (legacyVersion >= 1) {
      const now = new Date().toISOString()
      // Version 1 = initSchema (always applied if legacyVersion >= 1)
      db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        1,
        'init-schema',
        now,
      )
      for (const m of migrations) {
        if (m.version <= legacyVersion) {
          db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
            m.version,
            m.name,
            now,
          )
        }
      }
    }

    db.exec('DROP TABLE schema_version')
  }

  // ── Determine current state ────────────────────────────────────────────────
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  )

  // Fresh install — no migrations applied yet.
  if (!applied.has(1)) {
    initSchema(db)
    const now = new Date().toISOString()
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(1, 'init-schema', now)
    // Mark all incremental migrations as applied (initSchema creates the latest shape).
    for (const m of migrations) {
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        now,
      )
    }
    return
  }

  // Apply pending migrations sequentially.
  for (const m of migrations) {
    if (!applied.has(m.version)) {
      m.migrate(db)
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        new Date().toISOString(),
      )
    }
  }
}

/** Return the full migration history (for diagnostics / admin UI). */
export function getMigrationHistory(db: Database.Database): MigrationRecord[] {
  try {
    return db
      .prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version')
      .all() as MigrationRecord[]
  } catch {
    return []
  }
}
