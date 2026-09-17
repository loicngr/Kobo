import type { StopAgentOutcome } from '../utils/agent-stop-result.js'

/** Decouples the orchestrator's explicit Stop path from the transfer service. */
const handlers = new Map<
  string,
  { requested: () => void; settled: (outcome: StopAgentOutcome) => void; shutdown: () => void }
>()

export function registerHandoffStopHandler(
  workspaceId: string,
  handler: { requested: () => void; settled: (outcome: StopAgentOutcome) => void; shutdown: () => void },
): () => void {
  handlers.set(workspaceId, handler)
  return () => {
    if (handlers.get(workspaceId) === handler) handlers.delete(workspaceId)
  }
}

export function requestHandoffStop(workspaceId: string): ((outcome: StopAgentOutcome) => void) | undefined {
  const handler = handlers.get(workspaceId)
  handler?.requested()
  if (!handler) return undefined
  let settled = false
  return (outcome) => {
    if (settled) return
    settled = true
    handler.settled(outcome)
  }
}

export function suspendHandoffTransfers(): void {
  for (const handler of handlers.values()) handler.shutdown()
}
