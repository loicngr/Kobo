/**
 * Registry of "scopes with unsaved work".
 *
 * The client had no navigation guard at all: modified settings, a filled-in
 * creation form and a file edited in the diff viewer all vanished silently on
 * route change or tab close. Components register a predicate here; one router
 * guard and one beforeunload listener consult it.
 *
 * Keeping every scope (rather than one "is the page dirty" flag) is what fixes
 * the settings page's nastiest case: its banner was computed per tab, so
 * switching tabs made the warning DISAPPEAR and the user believed they had
 * saved.
 */

const scopes = new Map<string, () => boolean>()

export function registerUnsavedScope(id: string, isDirty: () => boolean): void {
  scopes.set(id, isDirty)
}

export function unregisterUnsavedScope(id: string): void {
  scopes.delete(id)
}

export function listDirtyScopes(): string[] {
  const dirty: string[] = []
  for (const [id, isDirty] of scopes) {
    try {
      if (isDirty()) dirty.push(id)
    } catch {
      // A predicate reading a torn-down component must never trap the user on
      // the page. Treat it as clean.
    }
  }
  return dirty
}

export function hasUnsavedWork(): boolean {
  return listDirtyScopes().length > 0
}

/** @internal — tests only. */
export function _clearUnsavedScopesForTest(): void {
  scopes.clear()
}
