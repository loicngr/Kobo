/** Folder (next to the worktrees) that holds the `.ai` folder of purged workspaces. Imported by the client: no Node modules here. */
export const KEPT_DIR_NAME = '.kobo-kept'

function isAbsoluteAnyFlavor(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(value)
}

/** The stored kept root, or null when missing, malformed, or not `<...>/.kobo-kept/<workspaceId>`. Pure: no disk access. */
export function keptAiPathOf(workspaceId: string, restoreDataJson: string | null | undefined): string | null {
  if (!restoreDataJson) return null
  let stored: unknown
  try {
    const parsed: unknown = JSON.parse(restoreDataJson)
    stored = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).keptAiPath : null
  } catch {
    return null
  }
  if (typeof stored !== 'string' || !isAbsoluteAnyFlavor(stored)) return null
  const segments = stored.split(/[\\/]+/).filter(Boolean)
  if (segments.length < 2 || segments.includes('.') || segments.includes('..')) return null
  if (segments[segments.length - 1] !== workspaceId || segments[segments.length - 2] !== KEPT_DIR_NAME) return null
  return stored
}
