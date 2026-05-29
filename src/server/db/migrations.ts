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
  {
    version: 5,
    name: 'add-agent-session-name',
    migrate: (db) => {
      db.exec('ALTER TABLE agent_sessions ADD COLUMN name TEXT')
    },
  },
  {
    version: 6,
    name: 'backfill-ws-events-session-id',
    migrate: (db) => {
      // Before this release, ws_events.session_id stored the Claude-generated
      // session ID. The frontend now filters by agent_sessions.id (internal nanoid),
      // so existing rows are invisible in the activity feed. Rewrite any
      // ws_events.session_id that matches an agent_sessions.claude_session_id to
      // the corresponding agent_sessions.id.
      db.exec(`
        UPDATE ws_events
        SET session_id = (
          SELECT a.id FROM agent_sessions a
          WHERE a.claude_session_id = ws_events.session_id
          LIMIT 1
        )
        WHERE session_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM agent_sessions a
            WHERE a.claude_session_id = ws_events.session_id
          )
      `)
    },
  },
  {
    version: 7,
    name: 'add-reasoning-effort',
    migrate: (db) => {
      db.exec("ALTER TABLE workspaces ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT 'auto'")
    },
  },
  {
    version: 8,
    name: 'add-workspace-favorited-at',
    migrate: (db) => {
      db.prepare('ALTER TABLE workspaces ADD COLUMN favorited_at TEXT').run()
    },
  },
  {
    version: 9,
    name: 'add-workspace-tags',
    migrate: (db) => {
      db.prepare("ALTER TABLE workspaces ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'").run()
    },
  },
  {
    version: 10,
    name: 'agent-engine-abstraction',
    migrate: (db) => {
      db.transaction(() => {
        db.prepare("ALTER TABLE workspaces ADD COLUMN engine TEXT NOT NULL DEFAULT 'claude-code'").run()
        db.prepare('ALTER TABLE agent_sessions RENAME COLUMN claude_session_id TO engine_session_id').run()
      })()
    },
  },
  {
    version: 11,
    name: 'add-pending-wakeups-table',
    migrate: (db) => {
      db.prepare(
        `CREATE TABLE IF NOT EXISTS pending_wakeups (
          workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
          target_at    TEXT NOT NULL,
          prompt       TEXT NOT NULL,
          reason       TEXT,
          created_at   TEXT NOT NULL
        )`,
      ).run()
    },
  },
  {
    version: 12,
    name: 'add-auto-loop-columns',
    migrate: (db) => {
      db.transaction(() => {
        db.prepare('ALTER TABLE workspaces ADD COLUMN auto_loop INTEGER NOT NULL DEFAULT 0').run()
        db.prepare('ALTER TABLE workspaces ADD COLUMN auto_loop_ready INTEGER NOT NULL DEFAULT 0').run()
        db.prepare('ALTER TABLE workspaces ADD COLUMN no_progress_streak INTEGER NOT NULL DEFAULT 0').run()
      })()
    },
  },
  {
    version: 13,
    name: 'add-permission-profile-column',
    migrate: (db) => {
      // 'bypass' (default, pre-existing behavior) or 'strict' (respects
      // the project's .claude/settings.json allow/deny lists — needed when
      // the user wants to authorize writes under .claude/** or .github/workflows/**
      // which the CLI hard-denies under --dangerously-skip-permissions).
      db.prepare("ALTER TABLE workspaces ADD COLUMN permission_profile TEXT NOT NULL DEFAULT 'bypass'").run()
    },
  },
  {
    version: 14,
    name: 'add-workspace-sentry-url',
    migrate: (db) => {
      db.prepare('ALTER TABLE workspaces ADD COLUMN sentry_url TEXT').run()
    },
  },
  {
    version: 15,
    name: 'add-workspace-worktree-path',
    migrate: (db) => {
      db.transaction(() => {
        db.prepare('ALTER TABLE workspaces ADD COLUMN worktree_path TEXT').run()
        db.prepare('ALTER TABLE workspaces ADD COLUMN worktree_owned INTEGER NOT NULL DEFAULT 1').run()
        db.prepare(
          "UPDATE workspaces SET worktree_path = project_path || '/.worktrees/' || working_branch WHERE worktree_path IS NULL",
        ).run()
      })()
    },
  },
  {
    version: 16,
    name: 'add-usage-snapshots-table',
    migrate: (db) => {
      db.prepare(
        `CREATE TABLE IF NOT EXISTS usage_snapshots (
          provider_id   TEXT PRIMARY KEY,
          status        TEXT NOT NULL,
          error_message TEXT,
          buckets_json  TEXT NOT NULL,
          fetched_at    TEXT NOT NULL
        )`,
      ).run()
    },
  },
  {
    version: 17,
    name: 'add-agent-permission-mode',
    migrate: (db) => {
      // Unifies the legacy `permission_mode` (auto-accept | plan) and
      // `permission_profile` (bypass | strict | interactive) into a single
      // SDK-aligned column with four values: plan | bypass | strict | interactive.
      //
      // Migration rule (preserves user-visible behaviour):
      //   permission_mode='plan'                                  → 'plan'
      //   permission_mode='auto-accept' + permission_profile=*    → permission_profile (default 'bypass')
      //
      // The two legacy columns are kept for backward compatibility — they are
      // no longer the source of truth but stay readable so older code paths
      // (or in-flight requests during deploy) don't crash.
      db.transaction(() => {
        db.prepare("ALTER TABLE workspaces ADD COLUMN agent_permission_mode TEXT NOT NULL DEFAULT 'bypass'").run()
        // Plan mode is preserved verbatim.
        db.prepare("UPDATE workspaces SET agent_permission_mode = 'plan' WHERE permission_mode = 'plan'").run()
        // For 'auto-accept' rows, promote the profile (or fall back to bypass).
        db.prepare(
          `UPDATE workspaces
           SET agent_permission_mode = CASE
             WHEN permission_profile IN ('bypass', 'strict', 'interactive') THEN permission_profile
             ELSE 'bypass'
           END
           WHERE permission_mode != 'plan'`,
        ).run()
      })()
    },
  },
  {
    version: 18,
    name: 'add-pending-wakeup-agent-session-id',
    migrate: (db) => {
      // Pin a wakeup to the session that scheduled it, so the wakeup resumes
      // that conversation instead of whichever session happens to be the
      // latest at fire time. Nullable: pre-migration rows fall back to the
      // legacy "last session" behaviour.
      db.prepare('ALTER TABLE pending_wakeups ADD COLUMN agent_session_id TEXT').run()
    },
  },
  {
    version: 19,
    name: 'add-pending-quota-backoffs',
    migrate: (db) => {
      // Per-workspace quota-backoff scheduler: tracks the moment a workspace
      // becomes eligible to retry after hitting a quota limit. Mirrors the
      // shape of pending_wakeups (one row per workspace, FK CASCADE) but holds
      // distinct fields (resets_at, source, retry_count) tied to the quota
      // detection layer (rate-limit info, usage API, fallback ladder).
      db.prepare(
        `CREATE TABLE IF NOT EXISTS pending_quota_backoffs (
          workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
          target_at    TEXT NOT NULL,
          resets_at    TEXT,
          source       TEXT NOT NULL CHECK (source IN ('rate_limit_info', 'usage_api', 'fallback_ladder')),
          retry_count  INTEGER NOT NULL DEFAULT 0,
          created_at   TEXT NOT NULL
        )`,
      ).run()
    },
  },
  {
    version: 20,
    name: 'add-workspace-description',
    migrate: (db) => {
      // Free-form, optional summary of the mission shown in the sidebar and
      // editable from the header. Nullable by design — pre-existing workspaces
      // keep description = NULL until the user (or the brainstorm agent) sets
      // one. Idempotent: skip the ALTER if the column is already present
      // (covers re-runs and the case where a fresh-install ran initSchema first).
      const cols = db.prepare('PRAGMA table_info(workspaces)').all() as Array<{ name: string }>
      if (cols.some((c) => c.name === 'description')) return
      db.prepare('ALTER TABLE workspaces ADD COLUMN description TEXT').run()
    },
  },
  {
    version: 21,
    name: 'add-workspace-agent-description',
    migrate: (db) => {
      // Agent-authored, optional summary of the mission written by the agent
      // (typically at the end of brainstorm) via the renamed
      // `set_workspace_agent_description` MCP tool. Distinct from the v20
      // `description` column, which stays human-editable. Nullable, no default.
      // Idempotent: skip the ALTER if the column already exists.
      const cols = db.prepare('PRAGMA table_info(workspaces)').all() as Array<{ name: string }>
      if (cols.some((c) => c.name === 'agent_description')) return
      db.prepare('ALTER TABLE workspaces ADD COLUMN agent_description TEXT').run()
    },
  },
  {
    version: 22,
    name: 'add-pending-crons',
    migrate: (db) => {
      // Per-workspace cron schedules: each row arms a recurring agent prompt
      // on a cron expression. Sibling timer table to pending_wakeups /
      // pending_quota_backoffs. Many rows per workspace (unlike the one-row
      // sibling tables), so id is the primary key. CASCADE on workspace
      // delete to keep the timer set tidy. Idempotent via IF NOT EXISTS.
      db.prepare(
        `CREATE TABLE IF NOT EXISTS pending_crons (
          id                TEXT PRIMARY KEY,
          workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          expression        TEXT NOT NULL,
          prompt            TEXT NOT NULL,
          label             TEXT,
          agent_session_id  TEXT,
          next_fire_at      TEXT NOT NULL,
          last_fired_at     TEXT,
          created_at        TEXT NOT NULL
        )`,
      ).run()
      db.prepare('CREATE INDEX IF NOT EXISTS idx_pending_crons_workspace ON pending_crons(workspace_id)').run()
      db.prepare('CREATE INDEX IF NOT EXISTS idx_pending_crons_next_fire ON pending_crons(next_fire_at)').run()
    },
  },
  {
    version: 23,
    name: 'add-pending-crons-one-shot',
    migrate: (db) => {
      // One-shot cron: fires once and cancels itself. Distinct from a wakeup
      // because it still uses cron expressions (can target an absolute date,
      // e.g. `0 14 7 6 *` = "next 7 June at 14:00") rather than a delay.
      // Default 0 (recurring) preserves existing behaviour.
      const cols = db.prepare('PRAGMA table_info(pending_crons)').all() as Array<{ name: string }>
      if (!cols.some((c) => c.name === 'one_shot')) {
        db.prepare('ALTER TABLE pending_crons ADD COLUMN one_shot INTEGER NOT NULL DEFAULT 0').run()
      }
    },
  },
  {
    version: 24,
    name: 'add-workspace-chat-history-table',
    migrate: (db) => {
      // Per-workspace chat history (user-typed messages). CASCADE on workspace
      // delete. Index supports the typical "latest N for a workspace" query via
      // (workspace_id, id DESC).
      db.exec(`
        CREATE TABLE IF NOT EXISTS workspace_chat_history (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id  TEXT    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          message       TEXT    NOT NULL,
          created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_chat_history_workspace_id_id
          ON workspace_chat_history(workspace_id, id DESC);
      `)
    },
  },
  {
    version: 25,
    name: 'add-workspace-initial-prompt',
    migrate: (db) => {
      // Stores the initial agent prompt assembled at workspace-creation time so
      // it survives a setup-script crash. Cleared after the agent successfully
      // ingests it; null otherwise (= nothing pending or already consumed).
      // Defensive: skip if the workspaces table doesn't exist yet — covers
      // synthetic test DBs that seed only a subset of tables before running
      // migrations.
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspaces'").get()
      if (!table) return
      const cols = db.prepare('PRAGMA table_info(workspaces)').all() as Array<{ name: string }>
      if (!cols.some((c) => c.name === 'initial_prompt')) {
        db.prepare('ALTER TABLE workspaces ADD COLUMN initial_prompt TEXT').run()
      }
    },
  },
  {
    version: 26,
    name: 'add-pr-attention-dismiss',
    migrate: (db) => {
      // Per-workspace "I've seen this" snapshot for the PR attention badges
      // (changes-requested + CI failure). Stores the pr.updatedAt at the
      // moment the user clicked "Marquer comme vu". The badge stays hidden
      // until a fresher pr.updatedAt is observed by the watcher.
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspaces'").get()
      if (!table) return
      const cols = db.prepare('PRAGMA table_info(workspaces)').all() as Array<{ name: string }>
      if (!cols.some((c) => c.name === 'pr_changes_dismissed_at')) {
        db.prepare('ALTER TABLE workspaces ADD COLUMN pr_changes_dismissed_at TEXT').run()
      }
      if (!cols.some((c) => c.name === 'pr_ci_failure_dismissed_at')) {
        db.prepare('ALTER TABLE workspaces ADD COLUMN pr_ci_failure_dismissed_at TEXT').run()
      }
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

  // Soft downgrade guard: if the database carries a migration version this
  // build doesn't know about, it was migrated by a newer Kōbō. Forward-only
  // migrations have no `down` step — warn loudly but let the app continue.
  const maxVersion =
    (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }).v ?? 0
  if (maxVersion > SCHEMA_VERSION) {
    console.warn(
      `[kobo] ⚠ Database schema version (${maxVersion}) is higher than this Kōbō build supports ` +
        `(${SCHEMA_VERSION}). The database was migrated by a newer version of Kōbō — running an older ` +
        `build may cause errors. Update Kōbō, or restore a pre-downgrade backup from the Kōbō home directory.`,
    )
  }
}

/**
 * Return the versions of registered migrations not yet applied to `db`, without
 * applying them. Used to decide whether a pre-migration backup is warranted.
 * Returns `[]` for a fresh / uninitialised database — there is no data at risk.
 */
export function getPendingMigrations(db: Database.Database): number[] {
  const tableExists = (name: string): boolean =>
    (
      db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name=?").get(name) as {
        c: number
      }
    ).c > 0

  let applied: Set<number>
  if (tableExists('schema_migrations')) {
    applied = new Set(
      (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
    )
  } else if (tableExists('schema_version')) {
    // Legacy single-row table: every version up to the stored one is applied.
    const legacy =
      (db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined)?.version ?? 0
    applied = new Set<number>()
    for (let v = 1; v <= legacy; v++) applied.add(v)
  } else {
    // Fresh / uninitialised DB — initSchema bootstraps it, nothing to back up.
    return []
  }

  return migrations.filter((m) => !applied.has(m.version)).map((m) => m.version)
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
