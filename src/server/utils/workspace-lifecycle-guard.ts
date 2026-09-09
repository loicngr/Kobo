const busyWorkspaces = new Set<string>()

export class WorkspaceLifecycleBusyError extends Error {
  readonly code = 'workspace-busy'

  constructor() {
    super('Another workspace operation is in progress. Wait for it to finish and retry.')
  }
}

export function isWorkspaceLifecycleBusy(id: string): boolean {
  return busyWorkspaces.has(id)
}

/** Exclude competing restore/purge/delete operations, including their awaits. */
export async function withWorkspaceLifecycleGuard<T>(id: string, action: () => Promise<T>): Promise<T> {
  if (busyWorkspaces.has(id)) throw new WorkspaceLifecycleBusyError()
  busyWorkspaces.add(id)
  try {
    return await action()
  } finally {
    busyWorkspaces.delete(id)
  }
}
