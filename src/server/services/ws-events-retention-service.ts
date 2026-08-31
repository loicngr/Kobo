import type Database from 'better-sqlite3'
import { recomputeSessionMetricsOn } from './workspace-service.js'

/** Rows deleted per transaction. Small enough that the SQLite write lock is
 *  never held for more than a few milliseconds at a time — the whole point of
 *  doing this AFTER the quadratic AFTER DELETE trigger was removed. */
const BATCH_SIZE = 5_000

/** Free-page ratio above which a full VACUUM is worth its cost. Production was
 *  measured at 620 free pages out of 656 (95 %) for zero remaining rows. */
const VACUUM_FREE_PAGE_RATIO = 0.25

/** Retention is OPT-IN: absent or invalid settings mean "delete nothing". */
const DISABLED = 0

/** The slice of global settings this service reads. */
export interface RetentionSettings {
  wsEventsRetentionDays?: number
  wsEventsKeepPerWorkspace?: number
}

export interface RetentionConfig {
  /** Events older than this are candidates for deletion. `0` disables retention entirely. */
  retentionDays: number
  /** Newest events per workspace that are never deleted, however old they are. */
  keepPerWorkspace: number
}

export interface RetentionResult {
  deleted: number
  sessionsRecomputed: number
  vacuumed: boolean
  freePagesBefore: number
  freePagesAfter: number
}

/** Anything that is not a non-negative integer falls back to "disabled": a bad
 *  value must never be read as a licence to delete. */
function normalize(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : DISABLED
}

/** Read the retention window from the global settings. */
export function resolveRetentionConfig(global: RetentionSettings): RetentionConfig {
  return {
    retentionDays: normalize(global.wsEventsRetentionDays),
    keepPerWorkspace: normalize(global.wsEventsKeepPerWorkspace),
  }
}

/** Shared candidate selection: rows older than the cutoff that fall outside the
 *  per-workspace tail. Used both to count (preview) and to delete. */
const CANDIDATE_CTE = `
  WITH ranked AS (
    SELECT rowid AS rid,
           workspace_id,
           session_id,
           created_at,
           ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY rowid DESC) AS rn
    FROM ws_events
  )`

function cutoffFor(config: RetentionConfig, nowMs: number): string {
  return new Date(nowMs - config.retentionDays * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * How many events `config` would delete right now. Deletes nothing — this backs
 * the confirmation dialog, so the user is told the real volume before agreeing
 * to destroy it.
 */
export function countPrunableWsEvents(
  db: Database.Database,
  config: RetentionConfig,
  nowMs: number = Date.now(),
): number {
  if (config.retentionDays <= 0) return 0
  const row = db
    .prepare(
      `${CANDIDATE_CTE}
       SELECT COUNT(*) AS c FROM ranked WHERE created_at < ? AND rn > ?`,
    )
    .get(cutoffFor(config, nowMs), config.keepPerWorkspace) as { c: number }
  return row.c
}

interface CandidateRow {
  rid: number
  workspace_id: string
  session_id: string | null
}

/**
 * Delete `ws_events` rows older than the retention window, batch by batch, then
 * recompute the metrics of the sessions touched and reclaim the freed pages.
 *
 * Deletes agent output ONLY: workspaces, tasks, sessions, branches and worktrees
 * are never touched.
 *
 * Order matters: this must never run while the removed `AFTER DELETE` trigger
 * is present — it re-aggregated the whole session per deleted row and held the
 * write lock long enough to make every concurrent WebSocket emit time out and
 * lose its event.
 */
export function pruneWsEvents(
  db: Database.Database,
  config: RetentionConfig,
  nowMs: number = Date.now(),
): RetentionResult {
  const freePagesBefore = (db.pragma('freelist_count', { simple: true }) as number) ?? 0
  const result: RetentionResult = {
    deleted: 0,
    sessionsRecomputed: 0,
    vacuumed: false,
    freePagesBefore,
    freePagesAfter: freePagesBefore,
  }
  if (config.retentionDays <= 0) return result

  const cutoff = cutoffFor(config, nowMs)
  const selectBatch = db.prepare(
    `${CANDIDATE_CTE}
     SELECT rid, workspace_id, session_id
     FROM ranked
     WHERE created_at < ? AND rn > ?
     ORDER BY rid ASC
     LIMIT ?`,
  )
  const deleteOne = db.prepare('DELETE FROM ws_events WHERE rowid = ?')
  const touched = new Set<string>()

  for (;;) {
    const batch = selectBatch.all(cutoff, config.keepPerWorkspace, BATCH_SIZE) as CandidateRow[]
    if (batch.length === 0) break
    db.transaction(() => {
      for (const row of batch) {
        deleteOne.run(row.rid)
        if (row.session_id) touched.add(`${row.workspace_id}::${row.session_id}`)
      }
    })()
    result.deleted += batch.length
    if (batch.length < BATCH_SIZE) break
  }

  // Once per session, at the very end — never per deleted row.
  for (const key of touched) {
    const separator = key.indexOf('::')
    const workspaceId = key.slice(0, separator)
    const sessionId = key.slice(separator + 2)
    try {
      recomputeSessionMetricsOn(db, workspaceId, sessionId)
      result.sessionsRecomputed += 1
    } catch (err) {
      console.error(`[retention] metric recompute failed (workspace=${workspaceId}, session=${sessionId}):`, err)
    }
  }

  if (result.deleted === 0) return result

  // Truncate the WAL, then compact only when it is actually worth it.
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  } catch (err) {
    console.error('[retention] wal_checkpoint failed:', err)
  }
  const freelist = (db.pragma('freelist_count', { simple: true }) as number) ?? 0
  const pageCount = (db.pragma('page_count', { simple: true }) as number) ?? 0
  if (pageCount > 0 && freelist / pageCount >= VACUUM_FREE_PAGE_RATIO) {
    try {
      db.exec('VACUUM')
      result.vacuumed = true
    } catch (err) {
      console.error('[retention] VACUUM failed:', err)
    }
  }
  result.freePagesAfter = (db.pragma('freelist_count', { simple: true }) as number) ?? 0
  return result
}
