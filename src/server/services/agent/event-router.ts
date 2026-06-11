import { emit, emitEphemeral } from '../websocket-service.js'
import type { AgentEvent } from './engines/types.js'

export function routeEvent(workspaceId: string, agentSessionId: string, event: AgentEvent): void {
  // The compaction "in progress" signal is a transient live indicator — deliver
  // it once and never persist/replay it. The persistent trace is `session:compacted`.
  if (event.kind === 'session:compacting') {
    emitEphemeral(workspaceId, 'agent:event', event)
    return
  }
  emit(workspaceId, 'agent:event', event, agentSessionId)
}
