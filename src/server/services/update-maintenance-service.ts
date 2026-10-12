/** Process-local reservation: restart clears it; only its owner may cancel it. */
let owner: string | undefined
const deferred = new Map<string, () => void>()
const creations = new Set<symbol>()

/** Reserve the entire creation/checkout, including asynchronous setup and rollback. */
export function beginWorkspaceCreation(): (() => void) | null {
  if (owner !== undefined) return null
  const creation = Symbol('workspace-creation')
  creations.add(creation)
  return () => {
    creations.delete(creation)
  }
}

export function isUpdateMaintenanceActive(): boolean {
  return owner !== undefined
}

/** No await between inspecting runtime ownership and closing admission. */
export function acquireUpdateMaintenance(candidate: string, isIdle: () => boolean): 'acquired' | 'busy' | 'conflict' {
  if (owner !== undefined) return owner === candidate ? 'acquired' : 'conflict'
  if (creations.size || !isIdle()) return 'busy'
  owner = candidate
  return 'acquired'
}

/** Keep scheduler rows/deadlines untouched while delivery is suspended. */
export function deferForUpdateMaintenance(key: string, callback: () => void): boolean {
  if (owner === undefined) return false
  deferred.set(key, callback)
  return true
}

export function releaseUpdateMaintenance(candidate: string): boolean {
  if (owner !== candidate) return false
  owner = undefined
  for (const callback of deferred.values()) {
    const timer = setTimeout(callback, 0)
    timer.unref?.()
  }
  deferred.clear()
  return true
}
