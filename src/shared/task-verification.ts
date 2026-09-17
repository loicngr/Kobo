export type TaskRole = 'work' | 'finalization'

export interface TaskVerification {
  method: string
  summary: string
  checks: Array<{ name: string; status: 'passed' | 'failed' | 'not_run' }>
}

/** Read persisted evidence without inventing verification for legacy tasks. */
export function parseTaskVerification(raw: string | null | undefined): TaskVerification | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as TaskVerification
  } catch {
    return null
  }
}
