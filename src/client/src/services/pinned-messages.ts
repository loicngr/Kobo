import type { PinnedEvent } from '../../../shared/pinned-messages'
import type { AgentEvent } from '../types/agent-event'
import { parseMessageSource } from '../utils/message-source'
import { foldEvents, mergeWithUserMessages } from './agent-event-view'
import { groupIntoTurns } from './conversation-turns'

export function pinnedMessageTurns(events: PinnedEvent[]) {
  const agentEvents = events.filter((event) => event.type === 'agent:event')
  const items = foldEvents(
    agentEvents.map((event) => event.payload as unknown as AgentEvent),
    agentEvents.map((event) => event.createdAt),
    false,
    agentEvents.map((event) => event.id),
  )
  const users = events
    .filter((event) => event.type === 'user:message' && typeof event.payload.content === 'string')
    .map((event) => ({
      content: event.payload.content as string,
      sender: typeof event.payload.sender === 'string' ? event.payload.sender : 'user',
      source: parseMessageSource(event.payload.source),
      ts: event.createdAt,
      eventIds: [event.id],
    }))
  return groupIntoTurns(mergeWithUserMessages(items, users))
}
