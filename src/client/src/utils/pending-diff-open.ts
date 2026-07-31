const pendingPaths = new Map<string, string>()

export function requestDiffOpen(workspaceId: string, path: string): void {
  pendingPaths.set(workspaceId, path)
}

export function takePendingDiffOpen(workspaceId: string): string | null {
  const path = pendingPaths.get(workspaceId) ?? null
  pendingPaths.delete(workspaceId)
  return path
}
