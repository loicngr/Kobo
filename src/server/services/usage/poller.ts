import { broadcastAll } from '../websocket-service.js'
import { upsertUsageSnapshot } from './db.js'
import { createClaudeCodeProvider } from './providers/claude-code.js'
import type { ProviderId, UsageProvider, UsageSnapshot } from './types.js'

// 5 minutes — the Anthropic `five_hour` / `seven_day` buckets are slow-moving
// so a tighter cadence just burns rate limit (429s) without surfacing fresher
// data to the UI. The user can still trigger a manual refresh via `refreshNow`.
export const POLL_INTERVAL_MS = 5 * 60_000

const DEFAULT_PROVIDERS: UsageProvider[] = [createClaudeCodeProvider()]

let providers: UsageProvider[] = DEFAULT_PROVIDERS
let intervalHandle: NodeJS.Timeout | null = null

function persistAndBroadcast(snap: UsageSnapshot): void {
  upsertUsageSnapshot(snap)
  broadcastAll('usage:snapshot', { providerId: snap.providerId, snapshot: snap })
}

async function tick(): Promise<void> {
  for (const provider of providers) {
    try {
      if (!(await provider.isAvailable())) continue
      const snap = await provider.fetchSnapshot()
      persistAndBroadcast(snap)
    } catch (err) {
      console.error('[usage-poller] tick failed for provider', provider.id, err)
    }
  }
}

export function startUsagePoller(): void {
  if (intervalHandle !== null) return
  void tick()
  intervalHandle = setInterval(() => {
    void tick()
  }, POLL_INTERVAL_MS)
}

export function stopUsagePoller(): void {
  if (intervalHandle === null) return
  clearInterval(intervalHandle)
  intervalHandle = null
}

// Bypasses `isAvailable()` — a manual refresh always returns a snapshot,
// even an `unauthenticated` one, so the UI gets feedback on the click.
export async function refreshNow(providerId: ProviderId): Promise<UsageSnapshot | null> {
  const provider = providers.find((p) => p.id === providerId)
  if (!provider) return null
  const snap = await provider.fetchSnapshot()
  persistAndBroadcast(snap)
  return snap
}

// Test seam — pass `null` to restore the default provider list.
export function _setProvidersForTest(list: UsageProvider[] | null): void {
  providers = list ?? DEFAULT_PROVIDERS
}
