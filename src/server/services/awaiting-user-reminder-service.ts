import { getDb } from '../db/index.js'
import { getGlobalSettings } from './settings-service.js'
import { broadcastAll } from './websocket-service.js'

/** How often the reminder loop looks at the clock. */
const TICK_INTERVAL_MS = 60_000

/** How long a workspace has been waiting, and how many reminders it has had. */
export interface ReminderState {
  firstSeenAt: number
  /** When the last reminder went out; null until the first one. */
  lastRemindedAt: number | null
  remindersSent: number
}

export interface DueReminder {
  id: string
  name: string
  waitingMs: number
  reminderNumber: number
}

/**
 * Which waiting workspaces are owed a reminder now.
 *
 * `state` is updated in place: entries appear when a workspace starts waiting
 * and disappear when it stops, so answering a question resets its clock.
 *
 * Pure apart from that mutation, which is what makes the interval arithmetic
 * — the part that is easy to get wrong — testable without a timer or a DB.
 */
export function computeDueReminders(params: {
  awaiting: Array<{ id: string; name: string }>
  now: number
  intervalMs: number
  state: Map<string, ReminderState>
}): DueReminder[] {
  const { awaiting, now, intervalMs, state } = params

  // Disabled. Clear the state too: re-enabling later should start from now,
  // not from a clock that kept running while the feature was off.
  if (intervalMs <= 0) {
    state.clear()
    return []
  }

  const stillWaiting = new Set(awaiting.map((w) => w.id))
  for (const id of state.keys()) {
    if (!stillWaiting.has(id)) state.delete(id)
  }

  const due: DueReminder[] = []
  for (const workspace of awaiting) {
    const existing = state.get(workspace.id)
    if (!existing) {
      // First sight. The question was just asked, so nothing is overdue yet.
      state.set(workspace.id, { firstSeenAt: now, lastRemindedAt: null, remindersSent: 0 })
      continue
    }

    // Measured from the LAST reminder (or the first sighting), not as a
    // multiple of the interval since the start: that way a change of interval
    // applies from the next reminder, and a laptop waking from sleep owing
    // four reminders sends one, not four, for the same unanswered question.
    const since = existing.lastRemindedAt ?? existing.firstSeenAt
    if (now - since < intervalMs) continue

    existing.lastRemindedAt = now
    existing.remindersSent += 1
    due.push({
      id: workspace.id,
      name: workspace.name,
      waitingMs: now - existing.firstSeenAt,
      reminderNumber: existing.remindersSent,
    })
  }
  return due
}

const reminderState = new Map<string, ReminderState>()
let timer: NodeJS.Timeout | null = null

function listAwaitingWorkspaces(): Array<{ id: string; name: string }> {
  return getDb()
    .prepare(`SELECT id, name FROM workspaces WHERE status = 'awaiting-user' AND archived_at IS NULL`)
    .all() as Array<{ id: string; name: string }>
}

/**
 * One pass of the reminder loop. Broadcast rather than emitted to the
 * workspace's subscribers: the whole point is to reach the user who is looking
 * at something else, or at nothing.
 *
 * Never throws — it runs on a timer nobody is watching, and an exception here
 * would silently end the loop for the rest of the process's life.
 */
export function runReminderTick(now: number = Date.now()): void {
  try {
    const minutes = getGlobalSettings().awaitingUserReminderMinutes
    // The API refuses more than a day; a hand-edited settings.json gets the
    // same ceiling here rather than a reminder that fires next week.
    const intervalMs = typeof minutes === 'number' && minutes > 0 ? Math.min(minutes, 1440) * 60_000 : 0
    if (intervalMs <= 0) {
      reminderState.clear()
      return
    }

    for (const reminder of computeDueReminders({
      awaiting: listAwaitingWorkspaces(),
      now,
      intervalMs,
      state: reminderState,
    })) {
      broadcastAll('workspace:awaiting-reminder', {
        workspaceId: reminder.id,
        workspaceName: reminder.name,
        waitingMinutes: Math.round(reminder.waitingMs / 60_000),
        reminderNumber: reminder.reminderNumber,
      })
    }
  } catch (err) {
    console.error('[awaiting-user-reminder] tick failed:', err)
  }
}

/** Start the reminder loop. Idempotent. */
export function startAwaitingUserReminder(): void {
  if (timer) return
  timer = setInterval(() => runReminderTick(), TICK_INTERVAL_MS)
  timer.unref?.()
}

/** Stop the reminder loop. */
export function stopAwaitingUserReminder(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/** @internal */
export function _resetForTest(): void {
  stopAwaitingUserReminder()
  reminderState.clear()
}
