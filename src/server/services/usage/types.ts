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

export interface UsageProvider {
  readonly id: ProviderId
  readonly displayName: string
  isAvailable(): Promise<boolean>
  // Must never throw — every error path folds into UsageSnapshot.status.
  fetchSnapshot(): Promise<UsageSnapshot>
}
