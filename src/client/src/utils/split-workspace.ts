/** Each embedded pane owns its Vue app, router, stores and terminal registry. */
export const isWorkspacePane =
  typeof window !== 'undefined' &&
  window.parent !== window &&
  new URLSearchParams(window.location.search).get('pane') === '1'

export function embeddedWorkspaceUrl(id: string, pathname = window.location.pathname): string {
  return `${pathname}?pane=1#/workspace/${encodeURIComponent(id)}`
}

export function normalizeSplitRatio(value: string | null): number {
  const parsed = Number(value ?? 50)
  return Number.isFinite(parsed) ? Math.max(25, Math.min(75, parsed)) : 50
}

export function splitWorkspaceQuery(selected: string | null, target: string): { left: string; right?: string } {
  return selected && selected !== target ? { left: selected, right: target } : { left: target }
}

export interface WorkspacePaneBridge {
  hasUnsavedWork: () => boolean
  navigate: (id: string) => Promise<unknown>
  workspaceId: () => string | undefined
  ready: () => boolean
}

export type WorkspacePaneWindow = Window & { koboPane?: WorkspacePaneBridge }

// Updating the address to reflect navigation already approved inside a pane is
// bookkeeping, not a departure from either editor. Only that exact URL bypasses
// the host dirty guard; ordinary links and closing split mode remain guarded.
let passiveNavigation: string | null = null
export function isPassiveSplitNavigation(to: { name?: unknown; fullPath: string }, from: { name?: unknown }): boolean {
  return from.name === 'split' && to.name === 'split' && to.fullPath === passiveNavigation
}
export async function syncSplitLocation(
  router: import('vue-router').Router,
  query: { left?: string; right?: string },
): Promise<void> {
  const target = { name: 'split', query }
  const fullPath = router.resolve(target).fullPath
  if (router.currentRoute.value.fullPath === fullPath || passiveNavigation) return
  passiveNavigation = fullPath
  try {
    await router.replace(target)
  } finally {
    passiveNavigation = null
  }
}

/** Queues from every workspace die with this iframe, even when not currently displayed. */
export function hasPanePendingWork(dirty: boolean, queues: Record<string, unknown>): boolean {
  return dirty || Object.keys(queues).length > 0
}
