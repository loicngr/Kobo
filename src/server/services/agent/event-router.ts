import { emit } from '../websocket-service.js'
import type { AgentEvent } from './engines/types.js'

export function routeEvent(workspaceId: string, agentSessionId: string, event: AgentEvent): void {
  emit(workspaceId, 'agent:event', event, agentSessionId)
}
