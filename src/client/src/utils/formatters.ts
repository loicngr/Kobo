import { useI18n } from 'vue-i18n'

/**
 * Returns a `timeAgo` function that uses i18n translations.
 * Must be called inside a Vue setup context (composable).
 *
 * Accepts either a date string or a Date object.
 */
export function useTimeAgo() {
  const { t } = useI18n()

  function timeAgo(input: string | Date): string {
    const then = typeof input === 'string' ? new Date(input).getTime() : input.getTime()
    const diffMs = Date.now() - then
    const diffMin = Math.floor(diffMs / 60000)
    if (diffMin < 1) return t('common.justNow')
    if (diffMin < 60) return t('common.minutesAgo', { count: diffMin })
    const diffH = Math.floor(diffMin / 60)
    if (diffH < 24) return t('common.hoursAgo', { count: diffH })
    const diffD = Math.floor(diffH / 24)
    return t('common.daysAgo', { count: diffD })
  }

  return { timeAgo }
}
