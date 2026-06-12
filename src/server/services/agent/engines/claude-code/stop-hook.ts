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

/**
 * Decide whether to nudge the agent to schedule a wakeup before it ends its
 * turn. The agent should be reminded ONLY when it leaves background work
 * in-flight with nothing scheduled to resume the session — otherwise the Kōbō
 * session goes idle and the work stalls.
 *
 * Returns false (clean stop, no nudge) when:
 *  - the stop hook is already active (anti-loop — we nudged on the prior stop);
 *  - there is no in-flight background work (a genuine end of turn);
 *  - an SDK-level cron/wakeup is scheduled (`session_crons`); or
 *  - a Kōbō-level wakeup is scheduled (`pending_wakeups`).
 */
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
    `⚠️ [Kōbō] You are about to end your turn with ${backgroundTaskCount} background task(s) still running, but NO wakeup is scheduled.`,
    'This Kōbō session will go idle and will NOT resume itself — the background work will stall and never be checked.',
    '',
    'Before ending your turn, do ONE of:',
    '• If you need that work to finish: call `kobo__schedule_wakeup` now with `delaySeconds` ≈ the expected remaining duration and a `prompt` telling future-you exactly what to check (log path + next step). Then end the turn.',
    '• If the background work is no longer needed: stop it (kill the process), then end the turn.',
    '',
    'Do not end the turn passively waiting — nothing will wake the session.',
  ].join('\n')
}

/** Raw subset of the SDK `StopHookInput` we read. */
export interface StopHookInputLike {
  stop_hook_active?: boolean
  background_tasks?: unknown[]
  session_crons?: unknown[]
}

/**
 * Build the Stop hook output for a workspace: cross-checks the SDK signals with
 * Kōbō's own `pending_wakeups` table (since `kobo__schedule_wakeup` is an MCP
 * tool that never appears in the SDK's `session_crons`) and returns the wakeup
 * nudge only when the agent is genuinely about to stall.
 */
export function buildStopHookOutput(workspaceId: string, input: StopHookInputLike): StopHookOutput {
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
