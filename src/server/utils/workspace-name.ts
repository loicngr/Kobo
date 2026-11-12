/**
 * Mirrors the private `WORKSPACE_NAME_MAX_LENGTH` in workspace-service.ts.
 * Duplicated rather than exported to avoid coupling this helper to that
 * module's internals and to the many `vi.mock(workspace-service.js, factory)`
 * test files that would otherwise need updating.
 */
const WORKSPACE_NAME_MAX_LENGTH = 200

/**
 * Cap an auto-derived title (Notion page title, Sentry issue title, PR/MR
 * title) before handing it to `updateWorkspaceName`, which throws on anything
 * longer. Right for a name the user typed; a long exception message pulled
 * from Sentry is not user input, and truncating it is the sane default.
 */
export function truncateWorkspaceName(name: string): string {
  if (name.length <= WORKSPACE_NAME_MAX_LENGTH) return name
  return `${name.slice(0, WORKSPACE_NAME_MAX_LENGTH - 1)}…`
}

/**
 * The name a workspace should take once a title was extracted for it, or
 * `null` when the current name is the user's own and must be left alone.
 */
export function resolveExtractedName(currentName: string, extractedTitle: string): string | null {
  return currentName === 'workspace' ? truncateWorkspaceName(extractedTitle) : null
}
