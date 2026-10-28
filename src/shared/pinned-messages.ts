export interface PinnedMessage {
  id: string
  workspaceId: string
  workspaceName: string
  sessionId: string | null
  sessionName: string | null
  eventId: string
  itemKeys: string[]
  speaker: 'user' | 'agent'
  preview: string
  messageCreatedAt: string
  createdAt: string
  archived: boolean
  sourceAvailable: boolean
}

export interface PinnedEvent {
  id: string
  workspaceId: string
  sessionId: string | null
  type: 'user:message' | 'agent:event'
  payload: Record<string, unknown>
  createdAt: string
}

export interface PinnedMessageDetail {
  pin: PinnedMessage
  events: PinnedEvent[]
}

export interface PinnedMessagesPage {
  pins: PinnedMessage[]
  hasMore: boolean
}
