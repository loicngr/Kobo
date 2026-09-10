import type { RouteLocationRaw } from 'vue-router'
import { splitWorkspaceQuery } from './split-workspace'

/** Navigate only to workspaces whose creation completed successfully. */
export function workspaceCreationRoute(created: readonly { id: string }[]): RouteLocationRaw | null {
  const first = created[0]
  if (!first) return null
  const second = created[1]
  if (second) return { name: 'split', query: splitWorkspaceQuery(first.id, second.id) }
  return { name: 'workspace', params: { id: first.id } }
}
