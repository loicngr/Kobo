export interface WhipSessionCandidate {
  id: string
  workspaceId: string
  status: string
}

export function getWhipRunningSessionId(workspaceId: string, sessions: readonly WhipSessionCandidate[]): string | null {
  const running = sessions.filter((session) => session.workspaceId === workspaceId && session.status === 'running')
  return running.length === 1 ? running[0]!.id : null
}
