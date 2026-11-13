import type { Workspace } from 'src/stores/workspace'
import { apiFetchResponse, apiResponseError } from './api'

export async function exportWorkspaceEvents(workspace: Pick<Workspace, 'id' | 'name'>) {
  const res = await apiFetchResponse(`/api/workspaces/${workspace.id}/events.csv`)
  if (!res.ok) throw await apiResponseError(res)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const slug = workspace.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const a = document.createElement('a')
  a.href = url
  a.download = `${slug || 'workspace'}-events.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
