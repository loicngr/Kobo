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
