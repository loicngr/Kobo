import { getPrStatusAsync, type PrSnapshot } from '../utils/git-ops.js'
import { stopDevServer } from './dev-server-service.js'
import { destroyTerminal } from './terminal-service.js'
import { emitEphemeral } from './websocket-service.js'
import { archiveWorkspace, getWorkspace, listWorkspaces, updateWorkspaceSourceBranch } from './workspace-service.js'

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

/** Tracks the last known PR snapshot per workspace, used to detect transitions
 *  (state, base, reviewDecision). */
const lastKnownPr = new Map<string, PrSnapshot>()

/**
 * Read-only snapshot map, keyed by workspace id. Used by the drawer indicator
 * AND the Git panel. Workspaces without a known PR are absent.
 */
export function getAllPrSnapshots(): Record<string, PrSnapshot> {
  const out: Record<string, PrSnapshot> = {}
  for (const [id, snap] of lastKnownPr) {
    out[id] = snap
  }
  return out
}

/**
 * Test-only escape hatch — drops the in-memory cache so each test starts
 * from a clean slate. Not part of the public API.
 */
export function _resetForTest(): void {
  lastKnownPr.clear()
}

export async function checkPrStatuses(): Promise<void> {
  const workspaces = listWorkspaces(false) // non-archived only

  // Clean up entries for workspaces that no longer exist
  for (const id of lastKnownPr.keys()) {
    if (!workspaces.some((ws) => ws.id === id)) {
      lastKnownPr.delete(id)
    }
  }

  for (const ws of workspaces) {
    try {
      const pr = await getPrStatusAsync(ws.projectPath, ws.workingBranch)
      if (!pr) continue

      const prev = lastKnownPr.get(ws.id)
      // We delay updating `lastKnownPr` until after the actions succeed.
      // Setting it eagerly would poison the cache: if updateWorkspaceSourceBranch
      // throws (transient DB issue, race with workspace deletion), the cache
      // already holds the new base and the user never sees the toast — the
      // next tick computes `prev.base === pr.base` and treats it as no-op.

      // Archive on a transition FROM OPEN to CLOSED/MERGED. Skips the
      // base-change detection below — archiving wins.
      if (prev?.state === 'OPEN' && (pr.state === 'MERGED' || pr.state === 'CLOSED')) {
        if (['extracting', 'brainstorming', 'executing'].includes(ws.status)) {
          // Agent is working — update the cache but skip auto-archive.
          // (The defensive base preservation from the no-base branch doesn't apply here
          // because we ARE in the OPEN→MERGED/CLOSED branch which always has a base.)
          lastKnownPr.set(ws.id, pr)
          continue
        }
        console.log(`[pr-watcher] PR ${pr.state.toLowerCase()} for workspace '${ws.name}' — archiving`)

        // Best-effort cleanup (same as manual archive): stop dev server + terminal.
        // Agent is already not running here (guarded above).
        try {
          stopDevServer(ws.id)
        } catch (err) {
          console.error(`[pr-watcher] stopDevServer failed for '${ws.name}':`, err instanceof Error ? err.message : err)
        }
        try {
          destroyTerminal(ws.id)
        } catch {
          // Terminal may not exist — ignore
        }

        archiveWorkspace(ws.id)
        lastKnownPr.delete(ws.id)
        emitEphemeral(ws.id, 'workspace:archived', {
          reason: `PR ${pr.state.toLowerCase()}`,
          prUrl: pr.url,
        })
        continue // do not run base-change detection on a workspace we just archived
      }

      // Review-decision transitions (only on OPEN PRs; first-sight is silent).
      // Reuses the baseline rule from base-change detection: emits only when we
      // observe an actual transition between two known states.
      if (pr.state === 'OPEN' && prev) {
        if (prev.reviewDecision !== 'CHANGES_REQUESTED' && pr.reviewDecision === 'CHANGES_REQUESTED') {
          emitEphemeral(ws.id, 'pr:changes-requested', {
            prNumber: pr.number,
            prUrl: pr.url,
          })
        } else if (prev.reviewDecision === 'CHANGES_REQUESTED' && pr.reviewDecision === 'APPROVED') {
          emitEphemeral(ws.id, 'pr:approved', {
            prNumber: pr.number,
            prUrl: pr.url,
          })
        }
      }

      // Base-branch change detection. Only relevant for OPEN PRs — closed/
      // merged PRs don't accept base changes. Skip if the GitHub response
      // didn't include a baseRefName (defensive against malformed data).
      if (pr.state !== 'OPEN' || !pr.base) {
        // Still update the cache for the state — keeps the OPEN→CLOSED/MERGED
        // archiving logic working on the next tick. Preserve the previous
        // `base` if the fresh snapshot is missing one (defensive).
        const next: PrSnapshot = pr.base ? pr : { ...pr, base: prev?.base ?? pr.base }
        lastKnownPr.set(ws.id, next)
        continue
      }

      // Comparison baseline:
      //  - If we've seen this workspace before, use the previous `base`.
      //  - Otherwise (first sight after boot/unarchive), compare with the
      //    `sourceBranch` recorded in the database — that catches base changes
      //    that happened while Kobo was offline.
      const previousBase = prev?.base ?? ws.sourceBranch
      if (previousBase === pr.base) {
        // No-op path: still record the snapshot so subsequent ticks have a baseline.
        lastKnownPr.set(ws.id, pr)
        continue
      }

      console.log(`[pr-watcher] PR base changed for workspace '${ws.name}': ${previousBase} → ${pr.base}`)
      try {
        updateWorkspaceSourceBranch(ws.id, pr.base)
      } catch (err) {
        console.error(
          `[pr-watcher] updateWorkspaceSourceBranch failed for '${ws.name}':`,
          err instanceof Error ? err.message : err,
        )
        // Don't poison the cache: leave the previous entry (or absence) so
        // the next tick retries the detection.
        continue
      }
      // Both the persistence and the emit are part of "we successfully
      // observed a base change" — only NOW commit the new state to the cache.
      lastKnownPr.set(ws.id, pr)
      emitEphemeral(ws.id, 'pr:base-changed', {
        oldBase: previousBase,
        newBase: pr.base,
        prUrl: pr.url,
      })
    } catch (err) {
      console.error(
        `[pr-watcher] Failed to check PR for workspace '${ws.name}':`,
        err instanceof Error ? err.message : err,
      )
    }
  }
}

/**
 * On-demand refresh of a single workspace's PR snapshot. Bypasses the 30s tick.
 * No side effects beyond cache update — no archive, no transition emits. The
 * user is watching the UI; we don't replay events for state they're already
 * looking at.
 *
 * Returns the fresh snapshot, or null if the workspace has no PR (cache entry
 * cleared in that case). Throws if the workspace doesn't exist.
 */
export async function refreshPrSnapshot(workspaceId: string): Promise<PrSnapshot | null> {
  const ws = getWorkspace(workspaceId)
  if (!ws) throw new Error(`Workspace '${workspaceId}' not found`)

  const snap = await getPrStatusAsync(ws.projectPath, ws.workingBranch)
  if (snap === null) {
    lastKnownPr.delete(workspaceId)
    return null
  }
  lastKnownPr.set(workspaceId, snap)
  return snap
}

/**
 * Runs a single check while honouring the `checking` re-entrancy guard. Used
 * both by the immediate boot-time kick-off and by the periodic timer tick.
 */
async function runOneCheck(): Promise<void> {
  if (checking) return
  checking = true
  try {
    await checkPrStatuses()
  } catch (err) {
    console.error('[pr-watcher] Unexpected error in checkPrStatuses:', err)
  } finally {
    checking = false
  }
}

function scheduleNext(): void {
  timer = setTimeout(async () => {
    await runOneCheck()
    scheduleNext()
  }, POLL_INTERVAL_MS)
  timer.unref?.()
}

/** Start polling GitHub for merged/closed PRs to auto-archive workspaces. */
export function startPrWatcher(): void {
  if (timer) return
  // Kick off an immediate check so the front-end has fresh PR data on boot
  // without waiting for the first 30s tick. Fire-and-forget; the recurring
  // loop is scheduled independently and the `checking` guard prevents overlap.
  void runOneCheck()
  scheduleNext()
}

/** Stop the PR watcher polling loop. */
export function stopPrWatcher(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}
