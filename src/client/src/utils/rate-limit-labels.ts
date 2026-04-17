/**
 * Map raw Claude `rateLimitType` values to localized, human-friendly labels.
 * Unknown values are returned unchanged — covers forward-compatibility when
 * Anthropic introduces new bucket types.
 */
export function formatRateLimitLabel(raw: string, t: (key: string) => string): string {
  if (raw === 'five_hour') return t('rateLimitType.fiveHour')
  if (raw === 'seven_day') return t('rateLimitType.sevenDay')
  return raw
}
