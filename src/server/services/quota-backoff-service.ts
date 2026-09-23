import { getDb } from '../db/index.js'
import { emitEphemeral } from './websocket-service.js'
import { getWorkspace } from './workspace-service.js'

export type QuotaBackoffSource = 'rate_limit_info' | 'usage_api' | 'fallback_ladder'

/**
 * WHY the backoff was armed, independent of `QuotaBackoffSource` (which only
 * describes how its *duration* was computed). `source` alone can't tell a
 * genuine Anthropic/OpenAI rate limit apart from Kōbō's own transient-failure
 * retry (server 500s, or the drain watchdog force-ending a stuck session) —
 * both can legitimately land on `fallback_ladder` when no precise reset time
 * is available. The UI previously used `source === 'fallback_ladder'` as a
 * proxy for "not a real quota hit", which mislabelled genuine quota hits
 * lacking reset info as "auto-resuming", and — the actual bug report this
 * fixed — could never distinguish an internal watchdog recovery from a real
 * quota hit at all once precise reset info happened to be present.
 */
export type QuotaBackoffReason = 'quota' | 'transient'

export interface PendingQuotaBackoff {
  workspaceId: string
  targetAt: string
  resetsAt: string | null
  source: QuotaBackoffSource
  reason: QuotaBackoffReason
  retryCount: number
  createdAt: string
}

interface PendingQuotaBackoffRow {
  workspace_id: string
  target_at: string
  resets_at: string | null
  source: QuotaBackoffSource
  reason: QuotaBackoffReason
  retry_count: number
  created_at: string
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()
const MAX_TIMEOUT_MS = 2_000_000_000
let suspended = false
type OnFire = (workspaceId: string, pending: PendingQuotaBackoff) => void
let onFireCallback: OnFire | null = null

function scheduleAt(workspaceId: string, targetAt: string): void {
  if (suspended) return
  const delay = Math.max(0, Date.parse(targetAt) - Date.now())
  const timer = setTimeout(
    () => {
      if (Date.now() < Date.parse(targetAt)) scheduleAt(workspaceId, targetAt)
      else fireOrSkip(workspaceId)
    },
    Math.min(delay, MAX_TIMEOUT_MS),
  )
  timer.unref?.()
  timers.set(workspaceId, timer)
}

/** Stop in-memory delivery without consuming the schedules needed by the next boot. */
export function suspendForShutdown(): void {
  suspended = true
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
}

function rowToPending(row: PendingQuotaBackoffRow): PendingQuotaBackoff {
  return {
    workspaceId: row.workspace_id,
    targetAt: row.target_at,
    resetsAt: row.resets_at,
    source: row.source,
    reason: row.reason,
    retryCount: row.retry_count,
    createdAt: row.created_at,
  }
}

/**
 * Schedule (or reschedule) the auto-resume timer for a workspace that just
 * hit a Claude quota. Persists the target time so it survives restarts and
 * keeps the in-RAM `setTimeout` alive for the current process.
 *
 * `delayMs` is the "fire-now-plus-delta" offset; it MUST already include
 * any safety margin the caller wants. orchestrator.handleQuota owns that math.
 */
export function arm(
  workspaceId: string,
  delayMs: number,
  meta: { resetsAt: string | null; source: QuotaBackoffSource; reason: QuotaBackoffReason; retryCount: number },
): void {
  const db = getDb()
  const now = new Date()
  const targetAt = new Date(now.getTime() + delayMs).toISOString()

  const retryCount = meta.retryCount
  if (!Number.isSafeInteger(retryCount) || retryCount < 1) throw new Error('retryCount must be a positive integer')

  db.prepare(
    `INSERT INTO pending_quota_backoffs (workspace_id, target_at, resets_at, source, reason, retry_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET
       target_at = excluded.target_at,
       resets_at = excluded.resets_at,
       source = excluded.source,
       reason = excluded.reason,
       retry_count = excluded.retry_count,
       created_at = excluded.created_at`,
  ).run(workspaceId, targetAt, meta.resetsAt, meta.source, meta.reason, retryCount, now.toISOString())

  const previous = timers.get(workspaceId)
  if (previous) clearTimeout(previous)
  timers.delete(workspaceId)
  scheduleAt(workspaceId, targetAt)

  emitEphemeral(workspaceId, 'agent:quota-backoff', {
    targetAt,
    resetsAt: meta.resetsAt,
    source: meta.source,
    reason: meta.reason,
    retryCount,
  })
}

/**
 * Cancel the pending backoff for a workspace. Returns true if a row existed
 * (and was deleted), false if there was nothing to cancel. Idempotent.
 */
export function cancel(workspaceId: string, reason: 'user' | 'archive' | 'deleted' | 'completed'): boolean {
  const db = getDb()
  const result = db.prepare('DELETE FROM pending_quota_backoffs WHERE workspace_id = ?').run(workspaceId)
  const existed = result.changes > 0
  const previous = timers.get(workspaceId)
  if (previous) {
    clearTimeout(previous)
    timers.delete(workspaceId)
  }
  if (existed) {
    emitEphemeral(workspaceId, 'agent:quota-backoff-cancelled', { reason })
  }
  return existed
}

export function getPending(workspaceId: string): PendingQuotaBackoff | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM pending_quota_backoffs WHERE workspace_id = ?').get(workspaceId) as
    | PendingQuotaBackoffRow
    | undefined
  return row ? rowToPending(row) : null
}

export function listPending(): PendingQuotaBackoff[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM pending_quota_backoffs').all() as PendingQuotaBackoffRow[]
  return rows.map(rowToPending)
}

export function setOnFireCallback(fn: OnFire): void {
  onFireCallback = fn
}

/**
 * Re-arm timers for rows persisted across restart. Future rows get a fresh
 * `setTimeout`; past rows fire immediately (delay = 0). Rows pointing at
 * archived or missing workspaces are deleted without firing.
 */
export function restoreOnBoot(onFire: OnFire): void {
  suspendForShutdown()
  suspended = false
  setOnFireCallback(onFire)
  const db = getDb()
  // Older versions could persist quota before awaiting a provider lookup,
  // then crash before writing its timer. Never leave that state ownerless.
  const orphaned = db
    .prepare(`SELECT id FROM workspaces WHERE auto_loop = 1
    AND status = 'quota' AND archived_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM auto_loop_runs WHERE workspace_id = workspaces.id AND state = 'blocked')
    AND NOT EXISTS (SELECT 1 FROM pending_quota_backoffs WHERE workspace_id = workspaces.id)`)
    .all() as Array<{ id: string }>
  for (const { id } of orphaned) {
    arm(id, 15 * 60_000, { resetsAt: null, source: 'fallback_ladder', reason: 'quota', retryCount: 1 })
  }
  const rows = db.prepare('SELECT * FROM pending_quota_backoffs').all() as PendingQuotaBackoffRow[]
  for (const row of rows) {
    const ws = getWorkspace(row.workspace_id)
    if (!ws || ws.archivedAt !== null) {
      db.prepare('DELETE FROM pending_quota_backoffs WHERE workspace_id = ?').run(row.workspace_id)
      continue
    }
    const previous = timers.get(row.workspace_id)
    if (previous) clearTimeout(previous)
    scheduleAt(row.workspace_id, row.target_at)
  }
}

/** Internal — invoked when a timer fires. */
function fireOrSkip(workspaceId: string): void {
  if (suspended) return
  timers.delete(workspaceId)
  const pending = getPending(workspaceId)
  if (!pending) return
  // Final archive check before firing — workspace might have been archived
  // between the timer being armed and now.
  const ws = getWorkspace(workspaceId)
  if (!ws || ws.archivedAt !== null) {
    cancel(workspaceId, 'archive')
    return
  }
  // Consume the persisted row BEFORE invoking the callback. If the server
  // crashes during the spawn the callback triggers, restoreOnBoot won't see
  // a stale row with target_at in the past and re-fire on the next start
  // (which would cause a double spawn). The cb's downstream effects (next
  // iteration, status transitions) are tracked by their own state.
  getDb().prepare('DELETE FROM pending_quota_backoffs WHERE workspace_id = ?').run(workspaceId)
  const cb = onFireCallback
  if (!cb) return
  try {
    cb(workspaceId, pending)
  } catch (err) {
    console.error(`[quota-backoff] Recovery callback failed for '${workspaceId}':`, err)
    // A callback that failed before acquiring a controller must not strand
    // the workspace after its durable timer was consumed.
    const current = getWorkspace(workspaceId)
    if (current?.autoLoop && !current.archivedAt && current.status === 'quota' && !getPending(workspaceId)) {
      arm(workspaceId, 15_000, { ...pending, retryCount: Math.max(1, pending.retryCount) })
    }
  }
}

/** @internal test-only */
export const _timers = timers
