export type EnvironmentCheckStatus = 'ok' | 'missing' | 'error' | 'unknown'
export type EnvironmentCheckCode =
  | 'node'
  | 'platform'
  | 'git'
  | 'shell'
  | 'storage'
  | 'runtime'
  | 'authentication'
  | 'model'
  | 'repository'
  | 'firstCommit'
  | 'projectWritable'
  | 'worktrees'

export interface EnvironmentReport {
  checkedAt: string
  engine: 'claude-code' | 'codex'
  checks: Array<{ code: EnvironmentCheckCode; status: EnvironmentCheckStatus }>
}
