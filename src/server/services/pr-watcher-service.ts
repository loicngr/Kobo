import { getPrStatusAsync } from '../utils/git-ops.js'
import { stopDevServer } from './dev-server-service.js'
import { destroyTerminal } from './terminal-service.js'
import { emitEphemeral } from './websocket-service.js'
import { archiveWorkspace, listWorkspaces, updateWorkspaceSourceBranch } from './workspace-service.js'

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

/** Tracks the last known PR state + base branch per workspace, used to
 *  detect both state transitions (OPEN → CLOSED/MERGED) and base-branch
 *  changes (`develop` → `main`). */
interface KnownPr {
  state: string
  base?: string
}
const lastKnownPr = new Map<string, KnownPr>()

/**
 * Read-only snapshot of PR states known to the watcher, keyed by workspace id.
 * Used by the drawer to show a small PR-open indicator without N separate
 * `gh pr view` calls per workspace. Only contains entries where a PR has been
 * detected at least once by the watcher since boot; workspaces without a PR
 * are absent from the map.
 */
export function getAllPrStates(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [id, known] of lastKnownPr) {
    out[id] = known.state
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
    // Only check workspaces that are not actively running an agent
    if (['extracting', 'brainstorming', 'executing'].includes(ws.status)) continue

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

      // Base-branch change detection. Only relevant for OPEN PRs — closed/
      // merged PRs don't accept base changes. Skip if the GitHub response
      // didn't include a baseRefName (defensive against malformed data).
      if (pr.state !== 'OPEN' || !pr.base) {
        // Still update the cache for the state — keeps the OPEN→CLOSED/MERGED
        // archiving logic working on the next tick.
        lastKnownPr.set(ws.id, { state: pr.state, base: prev?.base })
        continue
      }

      // Comparison baseline:
      //  - If we've seen this workspace before, use the previous `base`.
      //  - Otherwise (first sight after boot/unarchive), compare with the
      //    `sourceBranch` recorded in the database — that catches base changes
      //    that happened while Kobo was offline.
      const previousBase = prev?.base ?? ws.sourceBranch
      if (previousBase === pr.base) {
        // No-op path: still record the base so subsequent ticks have a baseline.
        lastKnownPr.set(ws.id, { state: pr.state, base: pr.base })
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
      lastKnownPr.set(ws.id, { state: pr.state, base: pr.base })
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
