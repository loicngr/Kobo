/** Agent-reported operational state, independent of verified task completion. */
export type ProgressStatus = 'running' | 'succeeded' | 'failed' | 'interrupted'
export interface ProgressBar {
  id: string
  workspaceId: string
  sessionId: string
  label: string
  step: string | null
  current: number | null
  total: number | null
  status: ProgressStatus
  dismissed: boolean
  dismissedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
  revision: number
  sequence: number
}
export interface ProgressScope {
  workspaceId: string
  sessionId: string
}
export type ProgressOwner = ProgressScope & ({ kind: 'internal'; launchId: string } | { kind: 'external' })
export interface CreateProgressBarInput {
  activityKey: string
  label: string
  step?: string | null
  current?: number | null
  total?: number | null
}
export interface UpdateProgressBarInput {
  sequence: number
  step?: string | null
  current?: number | null
  total?: number | null
}
export interface FinishProgressBarInput {
  sequence: number
  outcome: 'succeeded' | 'failed'
  step?: string | null
}
export interface ProgressBarList {
  items: ProgressBar[]
  totalCount: number
  nextOffset: number | null
  serverTime: string
}
export const PROGRESS_SUCCESS_VISIBLE_MS = 5_000
export const PROGRESS_MAX_RUNNING = 32
export const PROGRESS_MAX_RETAINED = 1_000
