/**
 * Curated palette for per-project colours. Quasar colour keys at the `-5`
 * intensity — picked to read well against Kōbō's dark theme. Append-only —
 * existing values must never move or be removed (settings.json may reference
 * them). New colours can be added at the end.
 */
export const PROJECT_COLOR_PALETTE = [
  'red-5',
  'pink-5',
  'purple-5',
  'deep-purple-5',
  'indigo-5',
  'blue-5',
  'cyan-5',
  'teal-5',
  'green-5',
  'amber-5',
  'orange-5',
  'brown-5',
] as const

export type ProjectColor = (typeof PROJECT_COLOR_PALETTE)[number]

export function isValidProjectColor(value: unknown): value is ProjectColor {
  return typeof value === 'string' && (PROJECT_COLOR_PALETTE as readonly string[]).includes(value)
}
