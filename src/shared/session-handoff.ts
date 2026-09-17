/** Public contract for a manual transfer to a fresh native conversation. */
export interface HandoffConfiguration {
  engine: string
  model: string
  reasoningEffort: string | null
  agentPermissionMode: 'plan' | 'bypass' | 'strict' | 'interactive'
}

export interface SessionHandoffRequest {
  requestId: string
  sourceSessionId: string | null
  target: HandoffConfiguration
  generateSummary: boolean
}

export type HandoffState = 'stopping' | 'generating' | 'starting' | 'completed' | 'failed' | 'interrupted' | 'cancelled'
export type HandoffDecision = 'retry' | 'skip' | 'cancel'

export interface SessionHandoff {
  id: string
  workspaceId: string
  sourceSessionId: string | null
  targetSessionId: string | null
  source: HandoffConfiguration
  target: HandoffConfiguration
  generateSummary: boolean
  state: HandoffState
  reportPath: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}

export function isHandoffPending(handoff: SessionHandoff | null | undefined): boolean {
  return !!handoff && handoff.state !== 'completed' && handoff.state !== 'cancelled'
}

export const HANDOFF_REPORT_MAX_CHARS = 24_000
