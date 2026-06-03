import { getWorkspace, listTasks } from '../../../workspace-service.js'

/**
 * Build the reminder text injected back into the agent at compaction time.
 * Returns an empty string if the workspace has neither tasks nor acceptance
 * criteria — the caller should treat that as "nothing to inject".
 *
 * Pure with respect to its inputs other than the SQLite reads done via
 * getWorkspace / listTasks, which keeps it trivially unit-testable.
 */
export function buildPreCompactCustomInstructions(workspaceId: string): string {
  const ws = getWorkspace(workspaceId)
  const tasks = listTasks(workspaceId)
  const criteria = tasks.filter((t) => t.isAcceptanceCriterion)
  const todos = tasks.filter((t) => !t.isAcceptanceCriterion)
  if (criteria.length === 0 && todos.length === 0) return ''
  let out = `Context reminder for the next session segment.\n`
  out += `Task: ${ws?.name ?? workspaceId}\n`
  if (todos.length > 0) {
    out += `\nTasks:\n${todos.map((t) => `- [${t.status === 'done' ? 'x' : ' '}] ${t.title}`).join('\n')}\n`
  }
  if (criteria.length > 0) {
    out += `\nAcceptance criteria:\n${criteria.map((t) => `- [${t.status === 'done' ? 'x' : ' '}] ${t.title}`).join('\n')}\n`
    out += `\nWhen you complete a criterion, tell the user which one so it can be marked as done.\n`
  }
  return out
}

/** Output shape for a SessionStart hook callback that re-injects the
 *  task/criteria reminder after a compaction. `{}` means "inject nothing". */
export interface CompactionSessionStartOutput {
  hookSpecificOutput?: {
    hookEventName: 'SessionStart'
    additionalContext: string
  }
}

/**
 * Decide what a SessionStart hook should return so the post-compaction segment
 * keeps the workspace's tasks and acceptance criteria in context.
 *
 * The reminder is injected ONLY when the session segment starts because of a
 * compaction (`source === 'compact'`) — normal startup/resume/clear get
 * nothing, matching the prior PreCompact-hook semantics.
 *
 * This replaces the old PreCompact `hookSpecificOutput` injection: the current
 * Claude Code hook schema dropped `PreCompactHookSpecificOutput`, so emitting
 * `{ hookEventName: 'PreCompact', additionalContext }` is rejected at runtime
 * with a ZodError. `SessionStart` (which fires with `source: 'compact'` after
 * compaction) does support `additionalContext` and is a valid output.
 */
export function buildCompactionSessionStartOutput(workspaceId: string, source: string): CompactionSessionStartOutput {
  if (source !== 'compact') return {}
  const reminder = buildPreCompactCustomInstructions(workspaceId)
  if (!reminder) return {}
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: reminder } }
}
