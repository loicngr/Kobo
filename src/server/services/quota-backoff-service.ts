import { getDb } from '../db/index.js'
import { emitEphemeral } from './websocket-service.js'
import { getWorkspace } from './workspace-service.js'

export type QuotaBackoffSource = 'rate_limit_info' | 'usage_api' | 'fallback_ladder'

export interface PendingQuotaBackoff {
  workspaceId: string
  targetAt: string
  resetsAt: string | null
  source: QuotaBackoffSource
  retryCount: number
  createdAt: string
}

interface PendingQuotaBackoffRow {
  workspace_id: string
  target_at: string
  resets_at: string | null
  source: QuotaBackoffSource
  retry_count: number
  created_at: string
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()
let onFireCallback: ((workspaceId: string) => void) | null = null

function rowToPending(row: PendingQuotaBackoffRow): PendingQuotaBackoff {
  return {
    workspaceId: row.workspace_id,
    targetAt: row.target_at,
    resetsAt: row.resets_at,
    source: row.source,
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
  meta: { resetsAt: string | null; source: QuotaBackoffSource },
): void {
  const db = getDb()
  const now = new Date()
  const targetAt = new Date(now.getTime() + delayMs).toISOString()

  const existing = db
    .prepare('SELECT retry_count FROM pending_quota_backoffs WHERE workspace_id = ?')
    .get(workspaceId) as { retry_count: number } | undefined
  const retryCount = (existing?.retry_count ?? 0) + 1

  db.prepare(
    `INSERT INTO pending_quota_backoffs (workspace_id, target_at, resets_at, source, retry_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET
       target_at = excluded.target_at,
       resets_at = excluded.resets_at,
       source = excluded.source,
       retry_count = excluded.retry_count,
       created_at = excluded.created_at`,
  ).run(workspaceId, targetAt, meta.resetsAt, meta.source, retryCount, now.toISOString())

  const previous = timers.get(workspaceId)
  if (previous) clearTimeout(previous)
  const timer = setTimeout(() => fireOrSkip(workspaceId), Math.max(0, delayMs))
  timer.unref?.()
  timers.set(workspaceId, timer)

  emitEphemeral(workspaceId, 'agent:quota-backoff', {
    targetAt,
    resetsAt: meta.resetsAt,
    source: meta.source,
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

export function setOnFireCallback(fn: (workspaceId: string) => void): void {
  onFireCallback = fn
}

/**
 * Re-arm timers for rows persisted across restart. Future rows get a fresh
 * `setTimeout`; past rows fire immediately (delay = 0). Rows pointing at
 * archived or missing workspaces are deleted without firing.
 */
export function restoreOnBoot(onFire: (workspaceId: string) => void): void {
  setOnFireCallback(onFire)
  const db = getDb()
  const rows = db.prepare('SELECT * FROM pending_quota_backoffs').all() as PendingQuotaBackoffRow[]
  for (const row of rows) {
    const ws = getWorkspace(row.workspace_id)
    if (!ws || ws.archivedAt !== null) {
      db.prepare('DELETE FROM pending_quota_backoffs WHERE workspace_id = ?').run(row.workspace_id)
      continue
    }
    const delta = new Date(row.target_at).getTime() - Date.now()
    const timer = setTimeout(() => fireOrSkip(row.workspace_id), Math.max(0, delta))
    timer.unref?.()
    timers.set(row.workspace_id, timer)
  }
}

/** Internal — invoked when a timer fires. */
function fireOrSkip(workspaceId: string): void {
  timers.delete(workspaceId)
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
  cb(workspaceId)
}

/** @internal test-only */
export const _timers = timers
