/**
 * An ISO date string when `value` is a string that parses as a date, else null.
 * The string is kept as received. Dates before 2000 are "not set": the GitHub CLI
 * prints `0001-01-01T00:00:00Z` for an absent date.
 */
export function ciDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) || ms < Date.UTC(2000, 0, 1) ? null : value
}

export interface CiJobLogs {
  status: string
  conclusion: string | null
  startedAt: string | null
  completedAt: string | null
  steps: Array<{
    number: number
    name: string
    status: string
    conclusion: string | null
    startedAt: string | null
    completedAt: string | null
  }>
  logs: string
  available: boolean
  truncated: boolean
}

export function githubJobTarget(value: string) {
  const match =
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/actions\/runs\/([1-9]\d*)\/job\/([1-9]\d*)(?:\?[^#]*)?(?:#.*)?$/.exec(
      value,
    )
  return match && !['.', '..'].includes(match[1]!) && !['.', '..'].includes(match[2]!)
    ? { owner: match[1]!, repo: match[2]!, runId: match[3]!, jobId: match[4]! }
    : null
}
