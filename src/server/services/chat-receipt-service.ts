import type { MessageSource } from '../../shared/workspace-message-types.js'
import { emit, emitEphemeral } from './websocket-service.js'

interface ChatDelivery {
  source?: MessageSource
  content: string
  sessionId?: string
  clientMessageId?: string
  force?: boolean
}

/** Correlate delivery confirmations without changing the legacy queue protocol. */
export function createChatReceipt(
  workspaceId: string,
  delivery: ChatDelivery,
  persist?: (payload: unknown, sessionId?: string) => void,
) {
  const correlation = delivery.clientMessageId ? { clientMessageId: delivery.clientMessageId } : {}
  return {
    accept(sessionId?: string): void {
      const payload = {
        content: delivery.content,
        sender: 'user',
        ...correlation,
        ...(delivery.source ? { source: delivery.source } : {}),
      }
      if (persist) persist(payload, sessionId)
      else if (delivery.clientMessageId)
        emit(workspaceId, 'user:message', payload, sessionId, { requirePersistence: true })
      else emit(workspaceId, 'user:message', payload, sessionId)
      if (delivery.force || delivery.clientMessageId) {
        emitEphemeral(workspaceId, 'chat:accepted', { sessionId, ...correlation })
      }
    },
    reject(message: string, reason?: string): void {
      emitEphemeral(workspaceId, 'chat:rejected', {
        sessionId: delivery.sessionId,
        content: delivery.content,
        message,
        ...correlation,
        ...(reason ? { reason } : {}),
      })
    },
  }
}
