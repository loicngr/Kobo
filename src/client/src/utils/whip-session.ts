export interface WhipSessionCandidate {
  id: string
  status: string
}

export function getWhipRunningSessionId(sessions: readonly WhipSessionCandidate[]): string | null {
  const running = sessions.filter((session) => session.status === 'running')
  return running.length === 1 ? running[0]!.id : null
}
