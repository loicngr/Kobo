import type { Subagent } from 'src/stores/workspace'
import type { AgentEvent, AgentEventOrigin } from 'src/types/agent-event'
import { isSubagentTask } from '../../../shared/subagent-classification'

type ActivitySubagent = Pick<Subagent, 'toolUseId' | 'taskId' | 'threadIds' | 'description' | 'taskType'>

/** Finds the sub-agent card which owns an activity event. */
export function findSubagentForActivity(
  origin: AgentEventOrigin | undefined,
  subagents: readonly ActivitySubagent[],
  toolCallId?: string,
): ActivitySubagent | undefined {
  if (origin?.kind !== 'subagent') return undefined
  const agents = subagents.filter(isSubagentTask)
  // A nested Agent call belongs to its own card, but an ordinary/background
  // tool call stays grouped with the real parent from its origin.
  const nested = toolCallId
    ? agents.find((agent) => agent.toolUseId === toolCallId || agent.taskId === toolCallId)
    : undefined
  if (nested) return nested
  return agents.find((subagent) => {
    const toolCallIds = new Set([subagent.toolUseId, ...(subagent.taskId ? [subagent.taskId] : [])])
    return (
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
