interface SessionCandidate {
  status: string
  startedAt: string
  endedAt: string | null
  activationOrder?: number
}

// Activation order also records handoff rollbacks without changing execution dates.
// Sessions predating this metadata retain the start/end-time fallback.
export function getCurrentSession<T extends SessionCandidate>(sessions: readonly T[]): T | undefined {
  const lastUsed = (session: T) =>
    Math.max(Date.parse(session.startedAt), Date.parse(session.endedAt ?? session.startedAt))
  return sessions.reduce<T | undefined>((current, candidate) => {
    if (!current) return candidate
    if ((candidate.status === 'running') !== (current.status === 'running')) {
      return candidate.status === 'running' ? candidate : current
    }
    if ((candidate.activationOrder ?? 0) !== (current.activationOrder ?? 0))
      return (candidate.activationOrder ?? 0) > (current.activationOrder ?? 0) ? candidate : current
    return lastUsed(candidate) > lastUsed(current) ? candidate : current
  }, undefined)
}
