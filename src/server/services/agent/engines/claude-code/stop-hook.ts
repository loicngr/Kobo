import { isWakeupScheduled } from '../../../wakeup-service.js'

/**
 * Output shape for a Stop hook callback. `{}` means "inject nothing / let the
 * turn end". A non-empty `hookSpecificOutput.additionalContext` is delivered to
 * the model as non-error feedback and the conversation CONTINUES so the model
 * can act on it (here: schedule a wakeup) before stopping again.
 */
export interface StopHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'Stop'
    additionalContext: string
  }
}

/** Decision inputs for {@link shouldNudgeWakeup} — all already-resolved counts/flags. */
export interface StopHookDecisionInput {
  /** True when this Stop is itself a continuation of a previous stop-hook nudge. */
  stopHookActive: boolean
  /** SDK `background_tasks` length — in-flight (running/pending/backgrounded) work. */
  backgroundTaskCount: number
  /** SDK `session_crons` length — built-in ScheduleWakeup/cron/loop that will wake the session. */
  sdkScheduledWakeupCount: number
  /** Whether Kōbō's own `pending_wakeups` table has a row for this workspace. */
  koboWakeupScheduled: boolean
}

/** Avoid repeated reminders when an existing follow-up already covers the work. */
export function shouldNudgeWakeup(input: StopHookDecisionInput): boolean {
  if (input.stopHookActive) return false
  if (input.backgroundTaskCount <= 0) return false
  if (input.sdkScheduledWakeupCount > 0) return false
  if (input.koboWakeupScheduled) return false
  return true
}

/** The decision-point reminder injected when {@link shouldNudgeWakeup} is true. */
export function buildNudgeText(backgroundTaskCount: number): string {
  return [
    `[Kōbō] ${backgroundTaskCount} background task(s) remain. SDK tracked background jobs may deliver completion notifications and continue the live session; do not duplicate that continuation.`,
    'Only for detached work or an external job with no completion notification: the parent may use `mcp__kobo-tasks__schedule_wakeup` with delaySeconds from now, a concrete follow-up prompt, and optional reason. Subagents must leave workspace wakeup coordination to the parent.',
    'Keep an accurate report of unfinished work. A running background task is not itself a reason to cancel it or to schedule another turn.',
  ].join('\n')
}

/** Raw subset of the SDK `StopHookInput` we read. */
export interface StopHookInputLike {
  stop_hook_active?: boolean
  background_tasks?: unknown[]
  session_crons?: unknown[]
}

/** Suppress follow-up advice when unavailable or already owned by auto-loop. */
export function buildStopHookOutput(
  workspaceId: string,
  input: StopHookInputLike,
  context: { canScheduleWakeup?: boolean; autoLoop?: boolean } = {},
): StopHookOutput {
  if (context.canScheduleWakeup === false || context.autoLoop) return {}
  const backgroundTaskCount = input.background_tasks?.length ?? 0
  const koboWakeupScheduled = isWakeupScheduled(workspaceId)
  const nudge = shouldNudgeWakeup({
    stopHookActive: input.stop_hook_active ?? false,
    backgroundTaskCount,
    sdkScheduledWakeupCount: input.session_crons?.length ?? 0,
    koboWakeupScheduled,
  })
  if (!nudge) return {}
  return { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: buildNudgeText(backgroundTaskCount) } }
}
