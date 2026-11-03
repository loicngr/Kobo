/** Operator-configurable memory limits; units are conservative UTF-8 estimates, not provider tokens. */
export const DEFAULT_MEMORY_LIMITS = {
  bootstrapTokens: 1_000,
  responseTokens: 1_000,
  responseHardTokens: 1_500,
  conversationTokens: 8_000,
  denialTokens: 500,
  fragmentChars: 60,
  bodyChars: 3_000,
  titleChars: 160,
  pageSize: 50,
  pageMaxSize: 100,
  outputBytes: 12_000,
  bootstrapBytes: 6_000,
}
export type MemoryLimits = typeof DEFAULT_MEMORY_LIMITS
export const MEMORY_LIMIT_RANGES: Record<keyof MemoryLimits, readonly [number, number]> = {
  bootstrapTokens: [256, 100_000],
  responseTokens: [1_000, 100_000],
  responseHardTokens: [1_000, 100_000],
  conversationTokens: [1_500, 1_000_000],
  denialTokens: [500, 10_000],
  fragmentChars: [1, 20_000],
  bodyChars: [1, 100_000],
  titleChars: [1, 1_000],
  pageSize: [1, 1_000],
  pageMaxSize: [1, 1_000],
  outputBytes: [1_500, 1_000_000],
  bootstrapBytes: [256, 1_000_000],
}

/** Validate patches against the current configuration before persisting any setting. */
export function resolveMemoryLimits(value: unknown, base: MemoryLimits = DEFAULT_MEMORY_LIMITS): MemoryLimits {
  if (value === undefined) return { ...base }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid memoryLimits')
  const limits = { ...base }
  for (const [key, input] of Object.entries(value)) {
    if (!Object.hasOwn(MEMORY_LIMIT_RANGES, key)) throw new TypeError(`Unknown memory limit: ${key}`)
    const name = key as keyof MemoryLimits
    const [min, max] = MEMORY_LIMIT_RANGES[name]
    if (!Number.isSafeInteger(input) || (input as number) < min || (input as number) > max)
      throw new TypeError(`memoryLimits.${key} must be an integer between ${min} and ${max}`)
    limits[name] = input as number
  }
  if (limits.responseTokens > limits.responseHardTokens) throw new TypeError('Response target exceeds response ceiling')
  if (limits.pageSize > limits.pageMaxSize) throw new TypeError('Default page size exceeds page ceiling')
  if (limits.denialTokens >= limits.conversationTokens)
    throw new TypeError('Denial reserve exceeds conversation budget')
  if (Math.max(limits.bootstrapTokens, limits.responseTokens) > limits.conversationTokens - limits.denialTokens)
    throw new TypeError('Bootstrap or response target exceeds available conversation budget')
  return limits
}
