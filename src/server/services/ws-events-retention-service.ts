import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type Database from 'better-sqlite3'

/** Keep each write transaction short enough for live event writers. */
const BATCH_SIZE = 500
const VACUUM_FREE_PAGE_RATIO = 0.25
const DISABLED = 0

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

function normalize(value: number | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : DISABLED
}

export function resolveRetentionConfig(global: RetentionSettings): RetentionConfig {
  return {
    retentionDays: normalize(global.wsEventsRetentionDays),
    keepPerWorkspace: normalize(global.wsEventsKeepPerWorkspace),
  }
}

function cutoffFor(config: RetentionConfig, nowMs: number): string {
  return new Date(nowMs - config.retentionDays * 24 * 60 * 60 * 1000).toISOString()
}

interface WorkspaceBoundary {
  workspaceId: string
  /** Exclusive upper bound: the first protected event, or the initial snapshot end. */
  beforeRowid: number
  afterRowid: number
}

/** Compute each protected tail once using the workspace/rowid index. Rows
 * appended beyond the initial rowid are outside this pass. The age cutoff also
 * protects newly emitted events while other workspaces continue writing. */
function workspaceBoundaries(db: Database.Database, keep: number): WorkspaceBoundary[] {
  return db.transaction(() => {
    const last = db.prepare('SELECT rowid AS rid FROM ws_events ORDER BY rowid DESC LIMIT 1').get() as
      | { rid: number }
      | undefined
    if (!last) return []
    const workspaces = db.prepare('SELECT id FROM workspaces ORDER BY id').all() as { id: string }[]
    const tail = db.prepare(
      'SELECT rowid AS rid FROM ws_events WHERE workspace_id = ? AND rowid <= ? ORDER BY rowid DESC LIMIT 1 OFFSET ?',
    )
    return workspaces.map(({ id }) => {
      const boundary = keep > 0 ? (tail.get(id, last.rid, keep - 1) as { rid: number } | undefined) : undefined
      return {
        workspaceId: id,
        beforeRowid: keep > 0 ? (boundary?.rid ?? 0) : last.rid + 1,
        afterRowid: 0,
      }
    })
  })()
}

/** Read-only preview, using the same protected boundaries as deletion. */
export function countPrunableWsEvents(
  db: Database.Database,
  config: RetentionConfig,
  nowMs: number = Date.now(),
): number {
  if (config.retentionDays <= 0) return 0
  const count = db.prepare(
    'SELECT COUNT(*) AS count FROM ws_events WHERE workspace_id = ? AND rowid < ? AND created_at < ?',
  )
  const cutoff = cutoffFor(config, nowMs)
  return workspaceBoundaries(db, config.keepPerWorkspace).reduce(
    (total, boundary) =>
      total + (count.get(boundary.workspaceId, boundary.beforeRowid, cutoff) as { count: number }).count,
    0,
  )
}

interface CandidateRow {
  id: string
  rid: number
  session_id: string | null
}

interface SessionMetricsSnapshot {
  rows: number
  maxRowid: number
  events: number
  toolCalls: number
  errors: number
  inputTokens: number
  outputTokens: number
}

/** Aggregate outside the write transaction; concurrent WAL writers may keep emitting. */
function readSessionMetrics(db: Database.Database, workspaceId: string, sessionId: string): SessionMetricsSnapshot {
  const signature = db
    .prepare(
      `SELECT COUNT(*) AS rows, COALESCE(MAX(rowid), 0) AS maxRowid
       FROM ws_events WHERE workspace_id = ? AND session_id = ?`,
    )
    .get(workspaceId, sessionId) as { rows: number; maxRowid: number }
  return { ...signature, ...readMetricsAfter(db, workspaceId, sessionId, 0) }
}

function readMetricsAfter(db: Database.Database, workspaceId: string, sessionId: string, afterRowid: number) {
  return db
    .prepare(
      `SELECT
         COUNT(*) AS events,
         COALESCE(SUM(CASE WHEN json_extract(e.payload, '$.kind') = 'tool:call' THEN 1 ELSE 0 END), 0) AS toolCalls,
         COALESCE(SUM(CASE WHEN json_extract(e.payload, '$.kind') = 'error'
           OR (json_extract(e.payload, '$.kind') = 'tool:result'
             AND json_extract(e.payload, '$.isError') = 1) THEN 1 ELSE 0 END), 0) AS errors,
         COALESCE(MAX(CASE WHEN json_extract(e.payload, '$.kind') = 'usage'
           AND json_type(e.payload, '$.inputTokens') IN ('integer', 'real')
           THEN CAST(json_extract(e.payload, '$.inputTokens') AS INTEGER) ELSE 0 END), 0) AS inputTokens,
         COALESCE(MAX(CASE WHEN json_extract(e.payload, '$.kind') = 'usage'
           AND json_type(e.payload, '$.outputTokens') IN ('integer', 'real')
           THEN CAST(json_extract(e.payload, '$.outputTokens') AS INTEGER) ELSE 0 END), 0) AS outputTokens
       FROM ws_events e
       JOIN agent_sessions s ON s.id = e.session_id AND s.workspace_id = e.workspace_id
       WHERE e.workspace_id = ? AND e.session_id = ? AND e.rowid > ?
         AND e.type = 'agent:event' AND json_valid(e.payload)`,
    )
    .get(workspaceId, sessionId, afterRowid) as {
    events: number
    toolCalls: number
    errors: number
    inputTokens: number
    outputTokens: number
  }
}

class RetentionPass {
  readonly result: RetentionResult
  private readonly boundaries: WorkspaceBoundary[]
  private readonly cutoff: string
  private readonly selectBatch: Database.Statement
  private readonly deleteOne: Database.Statement
  private readonly touched = new Map<string, Set<string>>()
  private workspaceIndex = 0

  constructor(
    private readonly db: Database.Database,
    config: RetentionConfig,
    nowMs: number,
  ) {
    const freePagesBefore = db.pragma('freelist_count', { simple: true }) as number
    this.result = {
      deleted: 0,
      sessionsRecomputed: 0,
      vacuumed: false,
      freePagesBefore,
      freePagesAfter: freePagesBefore,
    }
    this.boundaries = config.retentionDays > 0 ? workspaceBoundaries(db, config.keepPerWorkspace) : []
    this.cutoff = config.retentionDays > 0 ? cutoffFor(config, nowMs) : ''
    this.selectBatch = db.prepare(
      `SELECT id, rowid AS rid, session_id FROM ws_events
       WHERE workspace_id = ? AND rowid > ? AND rowid < ? AND created_at < ?
       ORDER BY rowid ASC LIMIT ?`,
    )
    this.deleteOne = db.prepare('DELETE FROM ws_events WHERE rowid = ? AND id = ?')
  }

  /** One indexed read and at most BATCH_SIZE deletes; no whole-table reranking. */
  step(): boolean {
    const boundary = this.boundaries[this.workspaceIndex]
    if (!boundary) return false
    const batch = this.selectBatch.all(
      boundary.workspaceId,
      boundary.afterRowid,
      boundary.beforeRowid,
      this.cutoff,
      BATCH_SIZE,
    ) as CandidateRow[]
    const touched = new Set<string>()
    const deleted = this.db
      .transaction(() => {
        let count = 0
        for (const row of batch) {
          const change = this.deleteOne.run(row.rid, row.id).changes
          count += change
          if (change && row.session_id) touched.add(row.session_id)
        }
        return count
      })
      .immediate()
    this.result.deleted += deleted
    if (touched.size) {
      const sessions = this.touched.get(boundary.workspaceId) ?? new Set<string>()
      for (const sessionId of touched) sessions.add(sessionId)
      this.touched.set(boundary.workspaceId, sessions)
    }
    if (batch.length) boundary.afterRowid = batch[batch.length - 1].rid
    if (batch.length < BATCH_SIZE) this.workspaceIndex++
    return true
  }

  async finishAsync(): Promise<RetentionResult> {
    for (const [workspaceId, sessions] of this.touched) {
      for (const sessionId of sessions) {
        // Transactional recompute cannot overwrite metrics from a concurrent emit.
        await this.recomputeAsync(workspaceId, sessionId)
        await yieldToEventLoop()
      }
    }
    return this.finish(false)
  }

  finishSync(compact: boolean): RetentionResult {
    for (const [workspaceId, sessions] of this.touched) {
      for (const sessionId of sessions) this.recomputeSync(workspaceId, sessionId)
    }
    return this.finish(compact)
  }

  private async recomputeAsync(workspaceId: string, sessionId: string): Promise<void> {
    while (!this.recomputeOnce(workspaceId, sessionId)) await yieldToEventLoop()
    this.result.sessionsRecomputed++
  }

  private recomputeSync(workspaceId: string, sessionId: string): void {
    while (!this.recomputeOnce(workspaceId, sessionId)) {
      // The synchronous maintenance API has no interleaved local writer;
      // a second connection may still change this session between phases.
    }
    this.result.sessionsRecomputed++
  }

  private recomputeOnce(workspaceId: string, sessionId: string): boolean {
    const snapshot = this.db.transaction(() => readSessionMetrics(this.db, workspaceId, sessionId))()
    return this.db
      .transaction(() => {
        const unchanged = this.db
          .prepare(
            `SELECT COUNT(*) AS rows FROM ws_events
           WHERE workspace_id = ? AND session_id = ? AND rowid <= ?`,
          )
          .get(workspaceId, sessionId, snapshot.maxRowid) as { rows: number }
        if (unchanged.rows !== snapshot.rows) return false

        // Rows appended after the read snapshot are small and are aggregated
        // under the lock so the insert trigger cannot race with our replacement.
        const appended = readMetricsAfter(this.db, workspaceId, sessionId, snapshot.maxRowid)
        this.db
          .prepare('DELETE FROM session_event_metrics WHERE workspace_id = ? AND session_id = ?')
          .run(workspaceId, sessionId)
        if (snapshot.events + appended.events === 0) return true
        this.db
          .prepare(
            `INSERT INTO session_event_metrics (
             workspace_id, session_id, tool_calls, errors, input_tokens, output_tokens
           ) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (
             SELECT 1 FROM agent_sessions WHERE id = ? AND workspace_id = ?
           )`,
          )
          .run(
            workspaceId,
            sessionId,
            snapshot.toolCalls + appended.toolCalls,
            snapshot.errors + appended.errors,
            Math.max(snapshot.inputTokens, appended.inputTokens),
            Math.max(snapshot.outputTokens, appended.outputTokens),
            sessionId,
            workspaceId,
          )
        return true
      })
      .immediate()
  }

  private finish(compact: boolean): RetentionResult {
    if (!this.result.deleted) return this.result
    // PASSIVE never waits for live readers. Reusable pages remain available for
    // new events. Full VACUUM is reserved for explicit offline maintenance.
    this.db.pragma(`wal_checkpoint(${compact ? 'TRUNCATE' : 'PASSIVE'})`)
    const freelist = this.db.pragma('freelist_count', { simple: true }) as number
    const pageCount = this.db.pragma('page_count', { simple: true }) as number
    if (compact && pageCount > 0 && freelist / pageCount >= VACUUM_FREE_PAGE_RATIO) {
      this.db.exec('VACUUM')
      this.result.vacuumed = true
    }
    this.result.freePagesAfter = this.db.pragma('freelist_count', { simple: true }) as number
    return this.result
  }
}

/** Synchronous helper for offline maintenance and fixtures. Never call from
 * HTTP handlers or the server scheduler; use the dedicated worker service. */
export function pruneWsEvents(
  db: Database.Database,
  config: RetentionConfig,
  nowMs: number = Date.now(),
  options: { compact?: boolean } = {},
): RetentionResult {
  const pass = new RetentionPass(db, config, nowMs)
  while (pass.step()) {}
  return pass.finishSync(options.compact ?? true)
}

/** Worker-only maintenance: yield between bounded transactions so stop requests
 * are handled promptly. Always repair touched session metrics before closing. */
export async function pruneWsEventsInBatches(
  db: Database.Database,
  config: RetentionConfig,
  nowMs: number = Date.now(),
  shouldStop: () => boolean = () => false,
): Promise<RetentionResult> {
  const pass = new RetentionPass(db, config, nowMs)
  try {
    while (!shouldStop() && pass.step()) await yieldToEventLoop()
  } catch (error) {
    await pass.finishAsync()
    throw error
  }
  return pass.finishAsync()
}
