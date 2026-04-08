import { getPrStatusAsync } from '../utils/git-ops.js'
import { emitEphemeral } from './websocket-service.js'
import { archiveWorkspace, listWorkspaces } from './workspace-service.js'

// ── PR Watcher ────────────────────────────────────────────────────────────────
// Polls GitHub every POLL_INTERVAL_MS to detect merged/closed PRs and
// automatically archive the corresponding workspace.
//
// Only archives on a STATE TRANSITION from OPEN → CLOSED/MERGED.
// If a PR is already closed/merged when first seen (e.g. after unarchive),
// it is recorded but NOT acted upon — prevents re-archiving manually
// unarchived workspaces.

const POLL_INTERVAL_MS = 30 * 1000 // 30 seconds

let timer: ReturnType<typeof setTimeout> | null = null
let checking = false

/** Tracks the last known PR state per workspace to detect transitions. */
const lastKnownState = new Map<string, string>()

async function checkPrStatuses(): Promise<void> {
  const workspaces = listWorkspaces(false) // non-archived only

  // Clean up entries for workspaces that no longer exist
  for (const id of lastKnownState.keys()) {
    if (!workspaces.some((ws) => ws.id === id)) {
      lastKnownState.delete(id)
    }
  }

  for (const ws of workspaces) {
    // Only check workspaces that are not actively running an agent
    if (['extracting', 'brainstorming', 'executing'].includes(ws.status)) continue

    try {
      const pr = await getPrStatusAsync(ws.projectPath, ws.workingBranch)
      if (!pr) continue

      const prev = lastKnownState.get(ws.id)
      lastKnownState.set(ws.id, pr.state)

      // Only archive on a transition FROM OPEN — not on first sight of CLOSED/MERGED
      if (prev === 'OPEN' && (pr.state === 'MERGED' || pr.state === 'CLOSED')) {
        console.log(`[pr-watcher] PR ${pr.state.toLowerCase()} for workspace '${ws.name}' — archiving`)
        archiveWorkspace(ws.id)
        lastKnownState.delete(ws.id)
        emitEphemeral(ws.id, 'workspace:archived', {
          reason: `PR ${pr.state.toLowerCase()}`,
          prUrl: pr.url,
        })
      }
    } catch (err) {
      console.error(
        `[pr-watcher] Failed to check PR for workspace '${ws.name}':`,
        err instanceof Error ? err.message : err,
      )
    }
  }
}

function scheduleNext(): void {
  timer = setTimeout(async () => {
    if (checking) {
      // Previous run still in progress — skip and reschedule
      scheduleNext()
      return
    }
    checking = true
    try {
      await checkPrStatuses()
    } catch (err) {
      console.error('[pr-watcher] Unexpected error in checkPrStatuses:', err)
    } finally {
      checking = false
      scheduleNext()
    }
  }, POLL_INTERVAL_MS)
  timer.unref?.()
}

/** Start polling GitHub for merged/closed PRs to auto-archive workspaces. */
export function startPrWatcher(): void {
  if (timer) return
  scheduleNext()
}

/** Stop the PR watcher polling loop. */
export function stopPrWatcher(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}
