export interface CiJobLogs {
  status: string
  conclusion: string | null
  steps: Array<{ number: number; name: string; status: string; conclusion: string | null }>
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
