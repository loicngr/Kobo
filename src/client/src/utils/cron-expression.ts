export type CronUnit = 'minutes' | 'hours' | 'days'

/**
 * Build a 5-field cron expression from the simple "every N <unit>" picker.
 * N is floored and clamped to a minimum of 1.
 */
export function cronExpressionFromPicker(unit: CronUnit, n: number): string {
  const k = Math.max(1, Math.floor(n))
  switch (unit) {
    case 'minutes':
      return `*/${k} * * * *`
    case 'hours':
      return `0 */${k} * * *`
    case 'days':
      return `0 0 */${k} * *`
  }
}

/**
 * `cronExpressionFromPicker('days', k)` compiles to a day-of-month step of k
 * (an asterisk-slash-k pattern on the day field), which resets to day 1 every month. For k > 1
 * this means the real-world interval between fires shrinks at month
 * boundaries (e.g. k=3 fires on day 28, day 31, then day 1 the very next
 * day). Standard 5-field cron has no "every N days from an arbitrary
 * start" primitive, so this is a real, unavoidable limitation of the
 * picker — surfaced to the user instead of silently producing a wrong
 * interval.
 */
export function cronDaysHasMonthBoundaryDrift(k: number): boolean {
  return Math.max(1, Math.floor(k)) > 1
}
