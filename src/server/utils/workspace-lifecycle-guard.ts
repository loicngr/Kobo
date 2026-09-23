const busyWorkspaces = new Map<string, { owner: symbol; reason?: string }>()
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

export function assertWorkspaceLifecycleAvailable(id: string, owner?: symbol): void {
  const reservation = busyWorkspaces.get(id)
  if (owner ? reservation?.owner !== owner : !!reservation) throw new WorkspaceLifecycleBusyError()
}

export function workspaceLifecycleReason(id: string): string | undefined {
  return busyWorkspaces.get(id)?.reason
}

export function reserveWorkspaceLifecycle(id: string, reason?: string): { owner: symbol; release: () => void } {
  assertWorkspaceLifecycleAvailable(id)
  const owner = Symbol(id)
  busyWorkspaces.set(id, { owner, reason })
  return {
    owner,
    release() {
      if (busyWorkspaces.get(id)?.owner !== owner) return
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
    },
  }
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
  const reservation = reserveWorkspaceLifecycle(id)
  try {
    return await action()
  } finally {
    reservation.release()
  }
}
