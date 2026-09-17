interface SessionCandidate {
  status: string
  startedAt: string
  endedAt: string | null
}

// Resuming a conversation keeps its creation date. Once it stops, endedAt
// identifies its latest use without changing the chronological session list.
export function getCurrentSession<T extends SessionCandidate>(sessions: readonly T[]): T | undefined {
  const lastUsed = (session: T) =>
    Math.max(Date.parse(session.startedAt), Date.parse(session.endedAt ?? session.startedAt))
  return sessions.reduce<T | undefined>((current, candidate) => {
    if (!current) return candidate
    if ((candidate.status === 'running') !== (current.status === 'running')) {
      return candidate.status === 'running' ? candidate : current
    }
    return lastUsed(candidate) > lastUsed(current) ? candidate : current
  }, undefined)
}
