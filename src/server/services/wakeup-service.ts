import path from 'node:path'
import { getDb } from '../db/index.js'
import * as orchestrator from './agent/orchestrator.js'
import { emitEphemeral } from './websocket-service.js'

export interface PendingWakeup {
  targetAt: string
  reason?: string
}

interface PendingWakeupRow {
  workspace_id: string
  target_at: string
  prompt: string
  reason: string | null
  created_at: string
}

const MIN_DELAY_SECONDS = 60
const MAX_DELAY_SECONDS = 3600
const STALE_WAKEUP_GRACE_MS = 5 * 60 * 1000
const AUTONOMOUS_LOOP_SENTINEL = '<<autonomous-loop-dynamic>>'
const AUTONOMOUS_LOOP_FALLBACK_PROMPT = 'Continue where you left off.'

/** In-memory timers — cleared on cancel/fire; rebuilt on boot via rehydrate. */
const timers = new Map<string, NodeJS.Timeout>()

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function rowToPending(row: PendingWakeupRow | undefined): PendingWakeup | null {
  if (!row) return null
  return { targetAt: row.target_at, reason: row.reason ?? undefined }
}

/** Schedule a wakeup for the given workspace. Replaces any existing pending wakeup. */
export function schedule(workspaceId: string, delaySeconds: number, prompt: string, reason: string | undefined): void {
  try {
    const clampedSeconds = clamp(Math.floor(delaySeconds), MIN_DELAY_SECONDS, MAX_DELAY_SECONDS)
    const effectivePrompt = prompt === AUTONOMOUS_LOOP_SENTINEL ? AUTONOMOUS_LOOP_FALLBACK_PROMPT : prompt
    const targetAtIso = new Date(Date.now() + clampedSeconds * 1000).toISOString()

    const existing = timers.get(workspaceId)
    if (existing) clearTimeout(existing)

    const db = getDb()
    db.prepare(
      `INSERT OR REPLACE INTO pending_wakeups
         (workspace_id, target_at, prompt, reason, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(workspaceId, targetAtIso, effectivePrompt, reason ?? null, new Date().toISOString())

    const timeout = setTimeout(() => fire(workspaceId), clampedSeconds * 1000)
    timeout.unref?.()
    timers.set(workspaceId, timeout)

    emitEphemeral(workspaceId, 'wakeup:scheduled', { targetAt: targetAtIso, reason })
  } catch (err) {
    console.error('[wakeup-service] schedule failed:', err)
  }
}

/** Cancel any pending wakeup for the workspace. Idempotent. */
export function cancel(
  workspaceId: string,
  reason: 'user-message' | 'stopped' | 'archived' | 'deleted' | 'manual',
): void {
  try {
    const existing = timers.get(workspaceId)
    if (existing) {
      clearTimeout(existing)
      timers.delete(workspaceId)
    }

    const db = getDb()
    const result = db.prepare('DELETE FROM pending_wakeups WHERE workspace_id = ?').run(workspaceId)

    if (result.changes > 0) {
      emitEphemeral(workspaceId, 'wakeup:cancelled', { reason })
    }
  } catch (err) {
    console.error('[wakeup-service] cancel failed:', err)
  }
}

/** Return the current pending wakeup for a workspace, or null if none. */
export function getPending(workspaceId: string): PendingWakeup | null {
  try {
    const db = getDb()
    const row = db.prepare('SELECT * FROM pending_wakeups WHERE workspace_id = ?').get(workspaceId) as
      | PendingWakeupRow
      | undefined
    return rowToPending(row)
  } catch (err) {
    console.error('[wakeup-service] getPending failed:', err)
    return null
  }
}

/** Re-register timers for rows persisted across restart. Skips stale entries. */
export function rehydrate(): void {
  try {
    const db = getDb()
    const rows = db.prepare('SELECT * FROM pending_wakeups').all() as PendingWakeupRow[]
    const now = Date.now()

    for (const row of rows) {
      try {
        const target = new Date(row.target_at).getTime()
        const delay = target - now

        if (delay > 0) {
          const timeout = setTimeout(() => fire(row.workspace_id), delay)
          timeout.unref?.()
          timers.set(row.workspace_id, timeout)
        } else if (-delay <= STALE_WAKEUP_GRACE_MS) {
          const timeout = setTimeout(() => fire(row.workspace_id), 0)
          timeout.unref?.()
          timers.set(row.workspace_id, timeout)
        } else {
          db.prepare('DELETE FROM pending_wakeups WHERE workspace_id = ?').run(row.workspace_id)
          console.log(
            `[wakeup-service] Skipping stale wakeup for workspace ${row.workspace_id} (late by ${Math.round(-delay / 1000)}s)`,
          )
        }
      } catch (err) {
        console.error('[wakeup-service] rehydrate row failed:', row.workspace_id, err)
      }
    }
  } catch (err) {
    console.error('[wakeup-service] rehydrate failed:', err)
  }
}

/** Internal — invoked by setTimeout. */
function fire(workspaceId: string): void {
  try {
    const db = getDb()

    // Atomic claim: SELECT + DELETE in a single transaction so a concurrent
    // cancel() can't race us between the read and the act. If we come out
    // with a row, it's ours exclusively; no other caller will ever see it.
    const row = db.transaction(() => {
      const r = db.prepare('SELECT * FROM pending_wakeups WHERE workspace_id = ?').get(workspaceId) as
        | PendingWakeupRow
        | undefined
      if (r) {
        db.prepare('DELETE FROM pending_wakeups WHERE workspace_id = ?').run(workspaceId)
      }
      return r
    })()

    timers.delete(workspaceId)

    if (!row) return

    if (orchestrator.hasController(workspaceId)) {
      emitEphemeral(workspaceId, 'wakeup:skipped', { reason: 'session-active' })
      return
    }

    const wsRow = db
      .prepare(
        `SELECT project_path, working_branch, worktree_path, model, agent_permission_mode, reasoning_effort
           FROM workspaces WHERE id = ?`,
      )
      .get(workspaceId) as
      | {
          project_path: string
          working_branch: string
          worktree_path: string | null
          model: string
          agent_permission_mode: string | null
          reasoning_effort: string
        }
      | undefined

    if (!wsRow) {
      emitEphemeral(workspaceId, 'wakeup:skipped', { reason: 'fire-failed' })
      return
    }

    const worktreePath = wsRow.worktree_path ?? path.join(wsRow.project_path, '.worktrees', wsRow.working_branch)
    // Narrow against the four known values; unknowns → 'bypass'.
    const stored = wsRow.agent_permission_mode
    const agentPermissionMode: 'plan' | 'bypass' | 'strict' | 'interactive' =
      stored === 'plan' || stored === 'strict' || stored === 'interactive' ? stored : 'bypass'

    try {
      orchestrator.startAgent(
        workspaceId,
        worktreePath,
        row.prompt,
        wsRow.model,
        true,
        agentPermissionMode,
        undefined,
        wsRow.reasoning_effort,
      )
      emitEphemeral(workspaceId, 'wakeup:fired', {})
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[wakeup-service] startAgent at fire time failed for '${workspaceId}':`, message)
      emitEphemeral(workspaceId, 'wakeup:skipped', { reason: 'fire-failed' })
    }
  } catch (err) {
    console.error('[wakeup-service] fire failed:', err)
    timers.delete(workspaceId)
  }
}
