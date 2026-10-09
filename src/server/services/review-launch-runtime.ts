/** Covers explicit Stop during asynchronous git preparation, before a durable return exists. */
const launches = new Map<string, { cancelled: boolean }>()

export function beginReviewLaunch(workspaceId: string): { cancelled: boolean } | null {
  if (launches.has(workspaceId)) return null
  const launch = { cancelled: false }
  launches.set(workspaceId, launch)
  return launch
}

export function cancelReviewLaunch(workspaceId: string): void {
  const launch = launches.get(workspaceId)
  if (launch) launch.cancelled = true
}

export function finishReviewLaunch(workspaceId: string): void {
  launches.delete(workspaceId)
}
