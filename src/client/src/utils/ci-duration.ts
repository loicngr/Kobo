type Timed = { status?: string | null; startedAt?: string | null; completedAt?: string | null }

const WAITING = new Set(['queued', 'pending', 'waiting', 'requested'])

// Total for bad input (commit statuses have no `status`, an old server no dates): never throws.
function time(value: unknown): number | null {
  const ms = typeof value === 'string' && value ? Date.parse(value) : Number.NaN
  return Number.isNaN(ms) ? null : ms
}

/** True when the item has started and is not finished. */
export function isCiRunning(item: Timed | null | undefined): boolean {
  if (typeof item?.status !== 'string') return false
  const status = item.status.toLowerCase()
  return time(item.startedAt) !== null && !item.completedAt && status !== 'completed' && !WAITING.has(status)
}

/** Elapsed milliseconds: end minus start when finished, now minus start when running, else null. Never negative. */
export function ciDurationMs(item: Timed | null | undefined, now: number): number | null {
  if (!item) return null
  const start = time(item.startedAt)
  if (start === null) return null
  if (item.completedAt) {
    const end = time(item.completedAt)
    return end === null ? null : Math.max(0, end - start)
  }
  return isCiRunning(item) ? Math.max(0, now - start) : null
}

/** Wall-clock span of a set: earliest start to latest end, or to `now` while one is running. Null when nothing has started. */
export function ciSpanMs(items: readonly (Timed | null | undefined)[], now: number): number | null {
  let first = Number.POSITIVE_INFINITY
  let last = Number.NEGATIVE_INFINITY
  for (const item of items) {
    if (!item || ciDurationMs(item, now) === null) continue
    const start = time(item.startedAt) as number
    first = Math.min(first, start)
    last = Math.max(last, isCiRunning(item) ? Math.max(now, start) : (time(item.completedAt) as number))
  }
  return first === Number.POSITIVE_INFINITY ? null : Math.max(0, last - first)
}

/** `45 s`, `3 min 05 s`, `1 h 02 min`. */
export function formatCiDuration(ms: number, t: (key: string, named: Record<string, unknown>) => string): string {
  const total = Math.floor(Math.max(0, ms) / 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  if (total < 60) return t('ciDuration.seconds', { s: total })
  if (total < 3600) return t('ciDuration.minutes', { m: Math.floor(total / 60), s: pad(total % 60) })
  return t('ciDuration.hours', { h: Math.floor(total / 3600), m: pad(Math.floor((total % 3600) / 60)) })
}
