import { getDb } from '../db/index.js'
import {
  finishMessageRequest,
  type MessageRequestResult,
  markMessageDispatching,
  reserveMessageRequest,
} from './mcp-message-request-service.js'
import { broadcastPersistedEvent, persistWorkspaceEvent } from './websocket-service.js'
import { deliverWorkspaceMessage, type WorkspaceMessage } from './workspace-message-service.js'

export async function deliverKeyedMcpMessage(
  workspaceId: string,
  key: string,
  message: WorkspaceMessage,
): Promise<MessageRequestResult> {
  const db = getDb()
  const request = reserveMessageRequest(db, workspaceId, key, message.content, message.sessionId)
  if (!request.fresh) return request.result
  let dispatched = false
  let accepted: Extract<MessageRequestResult, { accepted: true }> | undefined
  try {
    await deliverWorkspaceMessage(
      workspaceId,
      { ...message, clientMessageId: request.requestId },
      {
        beforeDispatch() {
          // The normal closed-engine fallback may enter this boundary again
          // while resuming the very same request, never a second reservation.
          if (dispatched) return
          markMessageDispatching(db, request.requestId)
          dispatched = true
        },
        persist(payload, sessionId) {
          const committed = db.transaction(() => {
            const event = persistWorkspaceEvent(workspaceId, 'user:message', payload, sessionId)
            const result = { accepted: true as const, requestId: request.requestId, eventId: event.id, sessionId }
            finishMessageRequest(db, request.requestId, 'accepted', result)
            return { event, result }
          })()
          accepted = committed.result
          broadcastPersistedEvent(committed.event)
        },
      },
    )
    if (!accepted) throw new Error('Delivery completed without a durable receipt')
    return accepted
  } catch (error) {
    // A notification failure cannot invalidate an already committed receipt.
    if (accepted) return accepted
    const result: MessageRequestResult = {
      accepted: false,
      requestId: request.requestId,
      code: dispatched ? 'delivery_unknown' : 'delivery_rejected',
      message: dispatched
        ? 'Delivery may have occurred; inspect history before sending a new request'
        : error instanceof Error
          ? error.message
          : String(error),
    }
    try {
      finishMessageRequest(db, request.requestId, dispatched ? 'unknown' : 'rejected', result)
    } catch {
      /* The reserved/dispatching row still prevents redelivery if storage failed. */
    }
    return result
  }
}
