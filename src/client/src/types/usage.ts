export type ProviderId = 'claude-code'

export interface UsageBucket {
  id: string
  label?: string
  usedPct: number
  resetsAt?: string
}

export interface UsageSnapshot {
  providerId: ProviderId
  status: 'ok' | 'unauthenticated' | 'error'
  errorMessage?: string
  buckets: UsageBucket[]
  fetchedAt: string
}
