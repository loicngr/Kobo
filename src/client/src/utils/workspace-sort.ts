import type { AgentLiveness, PrSnapshot, Workspace } from '../stores/workspace'
import { type AttentionKind, getAttentionReasons } from './workspace-attention'
import { filterWorkspaces } from './workspace-search'

export type WorkspaceSortField = 'activity' | 'created' | 'name' | 'attention'
export interface WorkspaceSort {
  field: WorkspaceSortField
  direction: 'asc' | 'desc'
}
export const WORKSPACE_SORT_KEY = 'kobo:workspace-sort'
export const WORKSPACE_SORT_FIELDS: WorkspaceSortField[] = ['activity', 'created', 'name', 'attention']
export const DEFAULT_WORKSPACE_SORT: WorkspaceSort = { field: 'activity', direction: 'desc' }

export function parseWorkspaceSort(raw: string | null): WorkspaceSort {
  try {
    const value = JSON.parse(raw ?? 'null')
    if (WORKSPACE_SORT_FIELDS.includes(value?.field) && ['asc', 'desc'].includes(value?.direction)) {
      return { field: value.field, direction: value.direction }
    }
  } catch {
    // Corrupt browser preferences must not prevent rendering the workspace list.
  }
  return { ...DEFAULT_WORKSPACE_SORT }
}

const ATTENTION_PRIORITY: Record<AttentionKind, number> = {
  'awaiting-user': 6,
  error: 5,
  'ci-failed': 5,
  'changes-requested': 4,
  quota: 3,
  'quota-retry': 2,
  'ready-to-merge': 1,
}

function timestamp(value: string | undefined): number {
  const parsed = Date.parse(value ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

/** Read markers are deliberately excluded: opening a workspace never raises its position. */
export function workspaceActivityAt(workspace: Workspace, liveness?: AgentLiveness): number {
  return Math.max(timestamp(workspace.createdAt), timestamp(workspace.updatedAt), timestamp(liveness?.lastEventAt))
}

export function sortWorkspaces<T extends Workspace>(
  workspaces: readonly T[],
  sort: WorkspaceSort,
  context: {
    liveness?: Record<string, AgentLiveness>
    snapshots?: Record<string, PrSnapshot>
    quotaBackoffReasons?: Record<string, 'quota' | 'transient'>
    query?: string
    locale?: string
  } = {},
): T[] {
  const collator = new Intl.Collator(context.locale, { numeric: true, sensitivity: 'base' })
  const values = new Map(
    workspaces.map((ws) => [
      ws.id,
      sort.field === 'attention'
        ? Math.max(
            0,
            ...getAttentionReasons(ws, context.snapshots?.[ws.id], context.quotaBackoffReasons?.[ws.id]).map(
              (reason) => ATTENTION_PRIORITY[reason.kind],
            ),
          )
        : sort.field === 'created'
          ? timestamp(ws.createdAt)
          : workspaceActivityAt(ws, context.liveness?.[ws.id]),
    ]),
  )
  const direction = sort.direction === 'asc' ? 1 : -1
  const sorted = [...workspaces].sort((a, b) => {
    const primary = sort.field === 'name' ? collator.compare(a.name, b.name) : values.get(a.id)! - values.get(b.id)!
    // A stable identifier prevents tied rows jumping when a refresh changes API ordering.
    return primary * direction || a.id.localeCompare(b.id)
  })
  // Search relevance remains primary; stable sorting preserves the preference for ties.
  return filterWorkspaces(context.query ?? '', sorted)
}
