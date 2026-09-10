/** A bounded stop is not proof that an engine has released its worktree. */
export type StopAgentOutcome = 'stopped' | 'not-running' | 'timeout' | 'failed'

export class AgentStopError extends Error {
  readonly code = 'agent-stop-incomplete'
  constructor(readonly outcome: StopAgentOutcome) {
    super(`Agent stop is not confirmed (${outcome}). Wait for it to stop and retry.`)
  }
}

export function assertAgentStopped(outcome: StopAgentOutcome): void {
  if (outcome !== 'stopped' && outcome !== 'not-running') throw new AgentStopError(outcome)
}
