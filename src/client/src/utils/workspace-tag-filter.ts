/** Tags offered by the drawer filter, with how many workspaces carry each. */
export interface TagCount {
  tag: string
  count: number
}

export function collectTags(
  workspaces: readonly { tags: readonly string[] }[],
  catalog: readonly string[] = [],
): TagCount[] {
  const counts = new Map<string, number>()
  for (const tag of catalog) counts.set(tag, 0)
  for (const workspace of workspaces) {
    for (const tag of new Set(workspace.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => a.tag.localeCompare(b.tag, undefined, { sensitivity: 'base' }))
}

/** OR semantics: at least one selected tag; an empty selection keeps everything. */
export function matchesTags(workspace: { tags: readonly string[] }, selected: readonly string[]): boolean {
  return selected.length === 0 || workspace.tags.some((tag) => selected.includes(tag))
}

/** Stored selection; anything malformed degrades to "no filter" rather than hiding everything. */
export function parseTagFilter(raw: string | null): string[] {
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === 'string') : []
  } catch {
    return []
  }
}
