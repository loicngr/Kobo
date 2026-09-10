const busyWorkspaces = new Set<string>()
const deferred = new Map<string, Set<() => void>>()

export class WorkspaceLifecycleBusyError extends Error {
  readonly code = 'workspace-busy'

  constructor() {
    super('Another workspace operation is in progress. Wait for it to finish and retry.')
  }
}

export function isWorkspaceLifecycleBusy(id: string): boolean {
  return busyWorkspaces.has(id)
}

export function assertWorkspaceLifecycleAvailable(id: string): void {
  if (busyWorkspaces.has(id)) throw new WorkspaceLifecycleBusyError()
}

/** Keep automatic work pending without polling or acquiring the guard recursively. */
export function deferUntilWorkspaceAvailable(id: string, retry: () => void): boolean {
  if (!busyWorkspaces.has(id)) return false
  const callbacks = deferred.get(id) ?? new Set<() => void>()
  callbacks.add(retry)
  deferred.set(id, callbacks)
  return true
}

/** Exclude competing restore/purge/delete operations, including their awaits. */
export async function withWorkspaceLifecycleGuard<T>(id: string, action: () => Promise<T>): Promise<T> {
  if (busyWorkspaces.has(id)) throw new WorkspaceLifecycleBusyError()
  busyWorkspaces.add(id)
  try {
    return await action()
  } finally {
    busyWorkspaces.delete(id)
    const callbacks = deferred.get(id)
    deferred.delete(id)
    if (callbacks)
      queueMicrotask(() => {
        for (const retry of callbacks) {
          try {
            retry()
          } catch (err) {
            console.error('[workspace-lifecycle] deferred operation failed:', err)
          }
        }
      })
  }
}
