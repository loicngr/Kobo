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
const generations = new Map<ProviderId, number>()
const switchingProviders = new Set<ProviderId>()
const latest = new Map<ProviderId, UsageSnapshot>()

function persistAndBroadcast(snap: UsageSnapshot): void {
  upsertUsageSnapshot(snap)
  latest.set(snap.providerId, snap)
  broadcastAll('usage:snapshot', { providerId: snap.providerId, snapshot: snap })
}

async function tick(): Promise<void> {
  for (const provider of providers) {
    try {
      const generation = generations.get(provider.id) ?? 0
      if (switchingProviders.has(provider.id) || !(await provider.isAvailable())) continue
      if (generation !== (generations.get(provider.id) ?? 0)) continue
      await refreshNow(provider.id)
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
  if (switchingProviders.has(providerId)) return latest.get(providerId) ?? null
  const generation = generations.get(providerId) ?? 0
  const snap = await provider.fetchSnapshot()
  // A request started with old credentials must not restore them in SQLite,
  // WebSocket clients, or its own delayed HTTP refresh response.
  if (generation !== (generations.get(providerId) ?? 0)) return latest.get(providerId) ?? null
  persistAndBroadcast(snap)
  return snap
}

/** Invalidate before changing credentials, including uncertain CLI failures. */
export async function withUsageAccountSwitch<T>(providerId: ProviderId, operation: () => Promise<T>): Promise<T> {
  generations.set(providerId, (generations.get(providerId) ?? 0) + 1)
  switchingProviders.add(providerId)
  try {
    persistAndBroadcast({
      providerId,
      status: 'error',
      buckets: [],
      fetchedAt: new Date().toISOString(),
      errorMessage: 'Account credentials are changing. Refresh usage after the switch.',
    })
    return await operation()
  } finally {
    switchingProviders.delete(providerId)
    try {
      await refreshNow(providerId)
    } catch {
      // Quota refresh failure must not turn a successful account mutation into
      // a failed switch or replace the original command error. Keep empty data.
    }
  }
}

// Test seam — pass `null` to restore the default provider list.
export function _setProvidersForTest(list: UsageProvider[] | null): void {
  providers = list ?? DEFAULT_PROVIDERS
  generations.clear()
  switchingProviders.clear()
  latest.clear()
}
