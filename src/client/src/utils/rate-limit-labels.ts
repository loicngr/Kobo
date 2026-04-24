/**
 * Map raw Claude `rateLimitType` values to localized, human-friendly labels.
 * Unknown values are returned unchanged — covers forward-compatibility when
 * Anthropic introduces new bucket types.
 */
export function formatRateLimitLabel(
  raw: string,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  if (raw === 'five_hour') return t('rateLimitType.fiveHour')
  if (raw === 'seven_day') return t('rateLimitType.sevenDay')
  return raw
}

export interface RateLimitDisplayBucket {
  id: string
  label?: string
  usedPct: number
  resetAt?: string
}

export function formatRateLimitResetAt(
  resetAt: string,
  options?: {
    locale?: string
    timeZone?: string
  },
): string {
  try {
    const parsed = new Date(resetAt)
    if (Number.isNaN(parsed.getTime())) return resetAt
    return parsed.toLocaleTimeString(options?.locale, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: options?.timeZone,
    })
  } catch {
    return resetAt
  }
}

export function formatRateLimitBucketLabel(
  bucket: RateLimitDisplayBucket,
  idx: number,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  if (bucket.id === 'text-detected' && bucket.resetAt) {
    return t('stats.resetsAt', { value: formatRateLimitResetAt(bucket.resetAt) })
  }
  if (!bucket.label || bucket.label.trim().length === 0) return t('stats.usageBucket', { n: idx + 1 })
  return formatRateLimitLabel(bucket.label, t)
}
