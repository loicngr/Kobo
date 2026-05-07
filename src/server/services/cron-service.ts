import { CronExpressionParser } from 'cron-parser'
import { nanoid } from 'nanoid'
import { getDb } from '../db/index.js'
import { slugifyProjectName } from '../utils/project-slug.js'
import { resolveWorkspaceWorktreePath } from '../utils/worktree-paths.js'
import * as orchestrator from './agent/orchestrator.js'
import * as settingsService from './settings-service.js'
import { emitEphemeral } from './websocket-service.js'

export interface PendingCron {
  id: string
  workspaceId: string
  expression: string
  prompt: string
  label: string | null
  agentSessionId: string | null
  nextFireAt: string
  lastFiredAt: string | null
  oneShot: boolean
  createdAt: string
}

interface PendingCronRow {
  id: string
  workspace_id: string
  expression: string
  prompt: string
  label: string | null
  agent_session_id: string | null
  next_fire_at: string
  last_fired_at: string | null
  one_shot: number
  created_at: string
}

export const MIN_DELAY_BETWEEN_FIRES_SECONDS = 60

// Node `setTimeout` stores the delay as a 32-bit signed int. Anything above
// 2^31-1 ms (~24.8 days) triggers `TimeoutOverflowWarning` and silently
// truncates to 1ms — which causes the timer to fire instantly and loop
// when the real target is years away (e.g. `@yearly` or `0 0 1 1 *`).
// We cap each setTimeout at this max and re-arm in the callback if the
// real fire time hasn't been reached yet.
const MAX_SETTIMEOUT_MS = 2_000_000_000 // ~23 days, with margin under 2^31-1

const timers = new Map<string, NodeJS.Timeout>()

/**
 * Arm a setTimeout that fires `fireOrSkip(id)` when `fireAt` is reached.
 * Replaces any existing timer for this id. Handles long horizons by
 * chaining capped timeouts, since Node's setTimeout overflows past ~24.8
 * days.
 */
function scheduleAt(id: string, fireAt: Date): void {
  const previous = timers.get(id)
  if (previous) clearTimeout(previous)
  const deltaMs = Math.max(0, fireAt.getTime() - Date.now())
  const cappedMs = Math.min(deltaMs, MAX_SETTIMEOUT_MS)
  const timer = setTimeout(() => {
    timers.delete(id)
    if (Date.now() >= fireAt.getTime()) {
      fireOrSkip(id)
    } else {
      // Long-horizon cron: hop forward another chunk and re-check.
      scheduleAt(id, fireAt)
    }
  }, cappedMs)
  timer.unref?.()
  timers.set(id, timer)
}

function rowToCron(row: PendingCronRow): PendingCron {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    expression: row.expression,
    prompt: row.prompt,
    label: row.label,
    agentSessionId: row.agent_session_id,
    nextFireAt: row.next_fire_at,
    lastFiredAt: row.last_fired_at,
    oneShot: row.one_shot === 1,
    createdAt: row.created_at,
  }
}

/**
 * Compute the next fire time for an expression strictly after `from`.
 * Uses cron-parser 5.x API. Throws with a descriptive error if the
 * expression is invalid. Helpers `@hourly` / `@daily` / `@weekly` /
 * `@monthly` / `@yearly` are accepted natively.
 */
function nextAfter(expression: string, from: Date): Date {
  try {
    const it = CronExpressionParser.parse(expression, { currentDate: from })
    return it.next().toDate()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Invalid cron expression: ${expression} — ${msg}`)
  }
}

/**
 * Validate the expression, persist the row, arm a setTimeout for the next
 * fire, emit `cron:created`. Throws on invalid expression OR when the next
 * fire is < MIN_DELAY_BETWEEN_FIRES_SECONDS seconds in the future.
 */
export function arm(
  workspaceId: string,
  args: { expression: string; prompt: string; label?: string; agentSessionId?: string; oneShot?: boolean },
): PendingCron {
  const now = new Date()
  const next = nextAfter(args.expression, now)
  const deltaMs = next.getTime() - now.getTime()
  if (deltaMs < MIN_DELAY_BETWEEN_FIRES_SECONDS * 1000) {
    throw new Error(
      `Cron expression resolves too close to now (minimum ${MIN_DELAY_BETWEEN_FIRES_SECONDS}s); use a longer interval`,
    )
  }

  const id = nanoid()
  const db = getDb()
  db.prepare(
    `INSERT INTO pending_crons (id, workspace_id, expression, prompt, label, agent_session_id, next_fire_at, last_fired_at, one_shot, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    id,
    workspaceId,
    args.expression,
    args.prompt,
    args.label ?? null,
    args.agentSessionId ?? null,
    next.toISOString(),
    args.oneShot ? 1 : 0,
    now.toISOString(),
  )

  scheduleAt(id, next)

  const cron = rowToCron(db.prepare('SELECT * FROM pending_crons WHERE id = ?').get(id) as PendingCronRow)
  emitEphemeral(workspaceId, 'cron:created', { cron })
  return cron
}

/**
 * Remove a single cron by id. Idempotent — returns false if no row matched.
 * Emits `cron:cancelled` only when a row was actually deleted.
 */
export function cancel(id: string, reason: 'user' | 'archive' | 'deleted' | 'completed'): boolean {
  const db = getDb()
  const row = db.prepare('SELECT workspace_id FROM pending_crons WHERE id = ?').get(id) as
    | { workspace_id: string }
    | undefined
  if (!row) return false
  db.prepare('DELETE FROM pending_crons WHERE id = ?').run(id)
  const previous = timers.get(id)
  if (previous) {
    clearTimeout(previous)
    timers.delete(id)
  }
  emitEphemeral(row.workspace_id, 'cron:cancelled', { id, reason })
  return true
}

/**
 * Remove every cron for a workspace. Returns the number of rows deleted.
 * Used by archive + delete cascades.
 */
export function cancelAllForWorkspace(workspaceId: string, reason: 'archive' | 'deleted'): number {
  const db = getDb()
  const rows = db.prepare('SELECT id FROM pending_crons WHERE workspace_id = ?').all(workspaceId) as Array<{
    id: string
  }>
  let deleted = 0
  for (const r of rows) {
    if (cancel(r.id, reason)) deleted++
  }
  return deleted
}

export function getCron(id: string): PendingCron | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM pending_crons WHERE id = ?').get(id) as PendingCronRow | undefined
  return row ? rowToCron(row) : null
}

export function listForWorkspace(workspaceId: string): PendingCron[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM pending_crons WHERE workspace_id = ? ORDER BY next_fire_at ASC')
    .all(workspaceId) as PendingCronRow[]
  return rows.map(rowToCron)
}

export function listAll(): PendingCron[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM pending_crons ORDER BY next_fire_at ASC').all() as PendingCronRow[]
  return rows.map(rowToCron)
}

/**
 * Internal — invoked by setTimeout when a cron's `next_fire_at` elapses.
 * Either fires (calls orchestrator.startAgent with resume=true) or skips
 * (when a controller is already active for the workspace), then recomputes
 * the next occurrence and re-arms a fresh setTimeout. Best-effort: any
 * unexpected error is logged and the cron is preserved when possible.
 */
function fireOrSkip(id: string): void {
  try {
    timers.delete(id)
    const db = getDb()
    const row = db.prepare('SELECT * FROM pending_crons WHERE id = ?').get(id) as PendingCronRow | undefined
    if (!row) return // cancelled in flight

    const wsRow = db
      .prepare(
        `SELECT project_path, working_branch, worktree_path, model, agent_permission_mode, reasoning_effort, archived_at
           FROM workspaces WHERE id = ?`,
      )
      .get(row.workspace_id) as
      | {
          project_path: string
          working_branch: string
          worktree_path: string | null
          model: string
          agent_permission_mode: string | null
          reasoning_effort: string
          archived_at: string | null
        }
      | undefined

    if (!wsRow || wsRow.archived_at !== null) {
      cancel(id, wsRow ? 'archive' : 'deleted')
      return
    }

    let status: 'fired' | 'skipped-active' = 'skipped-active'
    if (!orchestrator.hasController(row.workspace_id)) {
      status = 'fired'
      try {
        const globalSettings = settingsService.getGlobalSettings()
        const projectSettings = settingsService.getProjectSettings(wsRow.project_path)
        const projectSlug = globalSettings.worktreesPrefixByProject
          ? slugifyProjectName(projectSettings?.displayName ?? '', wsRow.project_path)
          : undefined
        const worktreePath =
          wsRow.worktree_path ??
          resolveWorkspaceWorktreePath(
            wsRow.project_path,
            wsRow.working_branch,
            globalSettings.worktreesPath,
            projectSlug,
          )
        const stored = wsRow.agent_permission_mode
        const agentPermissionMode: 'plan' | 'bypass' | 'strict' | 'interactive' =
          stored === 'plan' || stored === 'strict' || stored === 'interactive' ? stored : 'bypass'
        // agent_session_id encodes the cron's mode: non-NULL means "resume
        // that session" (pinned at create time); NULL means "fresh session
        // every fire" (clean context, no conversation continuity).
        const resumeMode = row.agent_session_id !== null
        orchestrator.startAgent(
          row.workspace_id,
          worktreePath,
          row.prompt,
          wsRow.model,
          resumeMode,
          agentPermissionMode,
          row.agent_session_id ?? undefined,
          wsRow.reasoning_effort,
        )
      } catch (err) {
        console.error(`[cron-service] startAgent at fire time failed for cron '${id}':`, err)
      }
    }

    const now = new Date()
    let nextFire: Date
    try {
      nextFire = nextAfter(row.expression, now)
    } catch (err) {
      // Defensive — the expression validated at create time, so reaching here
      // means cron-parser changed its acceptance rules between the original
      // arm and this fire. Cancel as 'completed' (the cron self-terminates)
      // rather than 'user' which would imply the user requested it.
      console.error(`[cron-service] failed to recompute next fire for cron '${id}':`, err)
      cancel(id, 'completed')
      return
    }

    // One-shot crons cancel themselves after a real fire (not on skip-active —
    // the user expects the cron to actually run once, so a skipped tick must
    // be retried at the next occurrence). Recurring crons re-arm normally.
    if (status === 'fired' && row.one_shot === 1) {
      db.prepare(`UPDATE pending_crons SET last_fired_at = ? WHERE id = ?`).run(now.toISOString(), id)
      emitEphemeral(row.workspace_id, 'cron:fired', {
        id,
        status,
        nextFireAt: null,
        lastFiredAt: now.toISOString(),
        oneShotConsumed: true,
      })
      cancel(id, 'completed')
      return
    }

    db.prepare(`UPDATE pending_crons SET next_fire_at = ?, last_fired_at = ? WHERE id = ?`).run(
      nextFire.toISOString(),
      now.toISOString(),
      id,
    )

    scheduleAt(id, nextFire)

    emitEphemeral(row.workspace_id, 'cron:fired', {
      id,
      status,
      nextFireAt: nextFire.toISOString(),
      lastFiredAt: now.toISOString(),
    })
  } catch (err) {
    console.error(`[cron-service] fireOrSkip uncaught error for cron '${id}':`, err)
    timers.delete(id)
  }
}

/**
 * Re-arm timers for rows persisted across restart. Skip-missed semantics:
 * if the stored next_fire_at is in the past, recompute next() based on the
 * current time and update the row before arming (mirror of POSIX crontab —
 * no catchup spam after server downtime).
 *
 * Rows pointing at deleted/archived workspaces are removed without firing.
 */
export function restoreOnBoot(): void {
  try {
    // Boot semantics: clear any existing in-memory timers before rearming.
    for (const t of timers.values()) clearTimeout(t)
    timers.clear()

    const db = getDb()
    const rows = db.prepare('SELECT * FROM pending_crons').all() as PendingCronRow[]
    const now = new Date()
    for (const row of rows) {
      try {
        const wsRow = db.prepare('SELECT archived_at FROM workspaces WHERE id = ?').get(row.workspace_id) as
          | { archived_at: string | null }
          | undefined
        if (!wsRow || wsRow.archived_at !== null) {
          db.prepare('DELETE FROM pending_crons WHERE id = ?').run(row.id)
          continue
        }

        const storedDate = new Date(row.next_fire_at)
        let nextFireAt: string
        if (storedDate.getTime() <= now.getTime()) {
          // Skip-missed semantics — no catchup spam after downtime.
          const next = nextAfter(row.expression, now)
          nextFireAt = next.toISOString()
        } else {
          // Future row: normalise the persisted ISO format.
          nextFireAt = storedDate.toISOString()
        }
        db.prepare('UPDATE pending_crons SET next_fire_at = ? WHERE id = ?').run(nextFireAt, row.id)

        scheduleAt(row.id, new Date(nextFireAt))
      } catch (err) {
        console.error(`[cron-service] restoreOnBoot row failed for cron '${row.id}':`, err)
      }
    }
  } catch (err) {
    console.error('[cron-service] restoreOnBoot failed:', err)
  }
}

/** @internal test-only */
export const _timers = timers
