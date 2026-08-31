import { fuzzyMatch } from './fuzzy-match'

/**
 * The subset of `Workspace` the drawer search reads. Declared structurally so
 * the module stays free of the Pinia store and trivially testable.
 */
export interface WorkspaceSearchable {
  name: string
  workingBranch: string
  sourceBranch: string
  description: string | null
  agentDescription: string | null
  tags: string[]
  projectPath: string
}

/**
 * Weight per field, in the order the card renders them. A hit on the name is
 * worth more than a hit on the project folder — otherwise every workspace of a
 * project would outrank the one actually named after the query.
 */
const FIELD_WEIGHTS = [3, 2, 2, 1.5, 1, 1]

/** Last path segment of a project path — what the card actually shows. */
function projectFolderName(projectPath: string): string {
  const trimmed = projectPath.replace(/[/\\]+$/, '')
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

/**
 * Every searchable field of a workspace, most significant first, blanks
 * removed. Mirrors what the drawer card displays: name, working branch,
 * description (agent's when present, exactly like the card), tags, project
 * folder, source branch.
 */
export function workspaceSearchFields(ws: WorkspaceSearchable): string[] {
  const description = ws.agentDescription || ws.description || ''
  return [
    ws.name,
    ws.workingBranch,
    description,
    ws.tags.join(' '),
    projectFolderName(ws.projectPath),
    ws.sourceBranch,
  ].filter((field) => field.trim().length > 0)
}

/**
 * Fuzzy score of `query` against a workspace, or `null` when no field matches.
 * The best-scoring field wins, weighted by field significance.
 */
export function matchWorkspace(query: string, ws: WorkspaceSearchable): number | null {
  const q = query.trim()
  if (q === '') return 0

  let best: number | null = null
  const fields = workspaceSearchFields(ws)
  // `workspaceSearchFields` drops blanks, so the weight index no longer lines
  // up with the field index. Re-derive the weight from the unfiltered order.
  const ordered = [
    ws.name,
    ws.workingBranch,
    ws.agentDescription || ws.description || '',
    ws.tags.join(' '),
    projectFolderName(ws.projectPath),
    ws.sourceBranch,
  ]
  for (let i = 0; i < ordered.length; i++) {
    const field = ordered[i] ?? ''
    if (field.trim().length === 0) continue
    if (!fields.includes(field)) continue
    const score = fuzzyMatch(q, field)
    if (score === null) continue
    const weighted = score * (FIELD_WEIGHTS[i] ?? 1)
    if (best === null || weighted > best) best = weighted
  }
  return best
}

/**
 * Filter AND rank a list of workspaces against `query`. An empty query returns
 * the list unchanged — the drawer's source order (`updated_at DESC`) must be
 * preserved when the user is not searching.
 */
export function filterWorkspaces<T extends WorkspaceSearchable>(query: string, list: T[]): T[] {
  if (query.trim() === '') return list
  return list
    .map((item) => ({ item, score: matchWorkspace(query, item) }))
    .filter((entry): entry is { item: T; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item)
}
