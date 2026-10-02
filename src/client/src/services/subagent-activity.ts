import type { Subagent } from 'src/stores/workspace'
import type { AgentEvent, AgentEventOrigin } from 'src/types/agent-event'

/** Finds the sub-agent card which owns an activity event. */
export function findSubagentForActivity(
  origin: AgentEventOrigin | undefined,
  subagents: readonly Pick<Subagent, 'toolUseId' | 'taskId' | 'threadIds' | 'description'>[],
  toolCallId?: string,
): Pick<Subagent, 'toolUseId' | 'taskId' | 'threadIds' | 'description'> | undefined {
  if (origin?.kind !== 'subagent') return undefined
  return subagents.find((subagent) => {
    const toolCallIds = new Set([subagent.toolUseId, ...(subagent.taskId ? [subagent.taskId] : [])])
    return (
      (toolCallId !== undefined && toolCallIds.has(toolCallId)) ||
      (origin.toolCallId !== undefined && toolCallIds.has(origin.toolCallId)) ||
      (origin.threadId !== undefined && (subagent.threadIds ?? []).includes(origin.threadId))
    )
  })
}

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
