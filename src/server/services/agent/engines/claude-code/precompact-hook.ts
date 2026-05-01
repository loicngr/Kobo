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
