import type { Subagent } from 'src/stores/workspace'
import type { AgentEvent } from 'src/types/agent-event'

/** Whether a provider-visible conversation event belongs to this card. */
export function belongsToSubagent(
  event: AgentEvent,
  subagent: Pick<Subagent, 'toolUseId' | 'taskId' | 'threadIds'>,
): boolean {
  if (!('origin' in event) || !event.origin || event.origin.kind !== 'subagent') return false
  const toolCallIds = new Set([subagent.toolUseId, ...(subagent.taskId ? [subagent.taskId] : [])])
  const isNestedToolCall =
    (event.kind === 'tool:call' || event.kind === 'tool:result') && toolCallIds.has(event.toolCallId)
  return (
    isNestedToolCall ||
    (event.origin.toolCallId !== undefined && toolCallIds.has(event.origin.toolCallId)) ||
    (event.origin.threadId !== undefined && (subagent.threadIds ?? []).includes(event.origin.threadId))
  )
}

/** Keep only the selected session's activity for one subagent card. */
export function subagentActivityEvents(
  events: AgentEvent[],
  sessionIds: Array<string | null>,
  subagent: Pick<Subagent, 'toolUseId' | 'taskId' | 'threadIds' | 'sessionId'>,
): AgentEvent[] {
  return events.filter(
    (event, index) =>
      (!subagent.sessionId || sessionIds[index] === subagent.sessionId) && belongsToSubagent(event, subagent),
  )
}
