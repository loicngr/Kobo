import type { RateLimitUsageBucket, RateLimitUsageSnapshot } from '../stores/workspace'

/**
 * Convert a `resetsAt` value from a Claude rate_limit_event into an ISO string.
 * - Number is treated as unix seconds (Claude's native format).
 * - String is returned as-is (legacy / test fixtures).
 */
function normalizeResetAt(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw.length > 0) return raw
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return new Date(raw * 1000).toISOString()
  }
  return undefined
}

/**
 * Extract usedPct from any of Claude's known shapes. Returns null when no
 * usage info is derivable (e.g. a plain `status: "allowed"` event).
 */
function extractUsedPct(source: Record<string, unknown>): number | null {
  const raw =
    source.used_percent ??
    source.percent_used ??
    source.utilization ??
    source.usage_ratio ??
    source.used_ratio ??
    source.usedPct
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw <= 1 ? raw * 100 : raw
  }
  const used = source.used ?? source.current ?? source.spent
  const limit = source.limit ?? source.max ?? source.allowed
  if (typeof used === 'number' && typeof limit === 'number' && limit > 0) {
    return (used / limit) * 100
  }
  return null
}

function makeBucket(id: string, source: Record<string, unknown>): RateLimitUsageBucket | null {
  const usedPct = extractUsedPct(source)
  const resetAt = normalizeResetAt(source.resets_at ?? source.reset_at ?? source.resetsAt ?? source.resetAt)
  const label =
    (typeof source.label === 'string' && source.label) ||
    (typeof source.name === 'string' && source.name) ||
    (typeof source.rateLimitType === 'string' && source.rateLimitType) ||
    undefined
  const used = source.used ?? source.current ?? source.spent
  const limit = source.limit ?? source.max ?? source.allowed
  const details = used !== undefined && limit !== undefined ? `${String(used)} / ${String(limit)}` : undefined

  // The only shape-level requirement: we must know either a usedPct OR have a
  // `rateLimitType`-style id to tag a "under threshold" (0%) bucket. That
  // decision lives in the caller; `makeBucket` only fails if no usedPct AND
  // caller supplied no fallback via `source.__fallbackUsedPct`.
  const fallback = source.__fallbackUsedPct
  const finalPct = usedPct ?? (typeof fallback === 'number' ? fallback : null)
  if (finalPct === null) return null

  return {
    id,
    label,
    usedPct: Math.max(0, Math.min(100, finalPct)),
    resetAt,
    details,
  }
}

function isExpired(bucket: RateLimitUsageBucket, nowMs: number): boolean {
  if (!bucket.resetAt) return false
  const t = new Date(bucket.resetAt).getTime()
  if (!Number.isFinite(t)) return false
  return t <= nowMs
}

/**
 * Build a `RateLimitUsageSnapshot` from a Claude `rate_limit_info` payload.
 *
 * - Understands Claude's native format (`rateLimitType` + optional `utilization`).
 * - A "healthy" event without `utilization` still produces a 0%-bucket so the
 *   UI refreshes its timestamp and drops stale warnings.
 * - When an `existing` snapshot is provided, non-expired buckets of OTHER
 *   `rateLimitType`s are preserved (e.g. the weekly bucket sticks around across
 *   5-hour events).
 * - Expired buckets (whose `resetAt` has passed) are dropped.
 *
 * Returns `null` only when the payload is genuinely unusable (no bucket produced
 * AND existing snapshot is empty/absent) — callers should leave the store
 * untouched in that case.
 */
export function normalizeRateLimitUsage(
  info: Record<string, unknown>,
  timestamp: string,
  existing?: RateLimitUsageSnapshot | null,
  nowMs: number = Date.now(),
): RateLimitUsageSnapshot | null {
  const collected: RateLimitUsageBucket[] = []
  const seenIds = new Set<string>()

  const push = (bucket: RateLimitUsageBucket | null): void => {
    if (!bucket || seenIds.has(bucket.id)) return
    collected.push(bucket)
    seenIds.add(bucket.id)
  }

  // Claude's native shape: top-level `rateLimitType` identifies the bucket.
  // A missing `utilization` in "allowed" status means usage is below the
  // warning threshold — we surface it as 0% so stale warnings are replaced.
  if (typeof info.rateLimitType === 'string') {
    push(makeBucket(info.rateLimitType, { ...info, __fallbackUsedPct: 0 }))
  }

  // Legacy/alternate shape: `info.buckets` array.
  if (Array.isArray(info.buckets)) {
    for (let i = 0; i < info.buckets.length; i++) {
      const entry = info.buckets[i]
      if (entry && typeof entry === 'object') {
        const asObj = entry as Record<string, unknown>
        const id =
          (typeof asObj.id === 'string' && asObj.id) ||
          (typeof asObj.name === 'string' && asObj.name) ||
          (typeof asObj.label === 'string' && asObj.label) ||
          `bucket-${i}`
        push(makeBucket(id, asObj))
      }
    }
  }

  // Legacy/alternate shape: any object-valued top-level property.
  for (const [key, value] of Object.entries(info)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    push(makeBucket(key, value as Record<string, unknown>))
  }

  // Merge with still-valid buckets from the existing snapshot.
  if (existing) {
    for (const bucket of existing.buckets) {
      if (seenIds.has(bucket.id)) continue
      if (isExpired(bucket, nowMs)) continue
      collected.push(bucket)
      seenIds.add(bucket.id)
    }
  }

  if (collected.length === 0) return null

  return {
    updatedAt: timestamp,
    buckets: collected,
  }
}
