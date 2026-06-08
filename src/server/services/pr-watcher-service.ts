import fs from 'node:fs'
import { fetchSourceBranchAsync, isGitWorktree } from '../utils/git-ops.js'
import { stopDevServer } from './dev-server-service.js'
import { getForgeProvider } from './forge/registry.js'
import { resolveForge } from './forge/resolve.js'
import type { PrSnapshot } from './forge/types.js'
import { computeGitStats, type GitStatsResult } from './git-stats-service.js'
import { getGlobalSettings } from './settings-service.js'
import { destroyTerminal } from './terminal-service.js'
import { emitEphemeral } from './websocket-service.js'
import {
  archiveWorkspace,
  getWorkspace,
  listArchivedWorkspaces,
  listWorkspaces,
  markWorkspaceUnread,
  restoreWorktreeFromDisk,
  updateWorkspaceSourceBranch,
} from './workspace-service.js'
import { purgeWorktree } from './worktree-purge-service.js'

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

/** Latest git-stats snapshot per workspace, refreshed each watcher tick. */
const lastKnownGitStats = new Map<string, GitStatsResult>()

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

/** Read-only git-stats map, keyed by workspace id. Used by the bulk
 *  `/api/workspaces/info` endpoint. */
export function getAllGitStats(): Record<string, GitStatsResult> {
  const out: Record<string, GitStatsResult> = {}
  for (const [id, s] of lastKnownGitStats) {
    out[id] = s
  }
  return out
}

/**
 * Test-only escape hatch — drops the in-memory cache so each test starts
 * from a clean slate. Not part of the public API.
 */
export function _resetForTest(): void {
  lastKnownPr.clear()
  lastKnownGitStats.clear()
}

/**
 * Flip a workspace to unread (DB + WS event) on a PR-attention transition.
 * Best-effort: a failure here must never break the watcher loop.
 */
function markUnread(workspaceId: string): void {
  try {
    markWorkspaceUnread(workspaceId)
    emitEphemeral(workspaceId, 'workspace:unread', { hasUnread: true })
  } catch (err) {
    console.error('[pr-watcher] markUnread failed:', err instanceof Error ? err.message : err)
  }
}

function autoRestoreManuallyRecreatedWorktrees(): void {
  for (const ws of listArchivedWorkspaces()) {
    if (!ws.worktreePurgedAt) continue
    if (!fs.existsSync(ws.worktreePath)) continue
    // Only a genuinely recreated worktree (gh pr checkout / git worktree add)
    // should trigger restore. A purge that failed to fully remove the folder
    // (e.g. root-owned Docker files) leaves a residual non-git directory that
    // satisfies existsSync but is NOT a valid worktree — restoring it would
    // wrongly un-archive the workspace and flood git fetches with "(null)".
    if (!isGitWorktree(ws.worktreePath)) continue
    try {
      const restored = restoreWorktreeFromDisk(ws.id)
      emitEphemeral(ws.id, 'workspace:worktree-restored', { workspace: restored })
      console.log(`[pr-watcher] auto-restored worktree for workspace '${ws.name}' (manual restore detected)`)
    } catch (err) {
      console.error(`[pr-watcher] auto-restore failed for '${ws.name}':`, err instanceof Error ? err.message : err)
    }
  }
}

export async function checkPrStatuses(): Promise<void> {
  autoRestoreManuallyRecreatedWorktrees()
  const workspaces = listWorkspaces(false) // non-archived only

  // Clean up entries for workspaces that no longer exist
  for (const id of lastKnownPr.keys()) {
    if (!workspaces.some((ws) => ws.id === id)) {
      lastKnownPr.delete(id)
    }
  }
  for (const id of lastKnownGitStats.keys()) {
    if (!workspaces.some((ws) => ws.id === id)) {
      lastKnownGitStats.delete(id)
    }
  }

  for (const ws of workspaces) {
    // Without this guard, every git/forge spawn below fails with ENOENT and
    // floods the logs when a worktree was deleted externally.
    if (!fs.existsSync(ws.worktreePath)) continue

    try {
      const pr = await getForgeProvider(resolveForge(ws.projectPath)).getPrStatus(ws.worktreePath, ws.workingBranch)

      // Detect a PR base change BEFORE computing git stats so the new base
      // is used in commitCount / behindCount / diffStats. Otherwise the
      // user keeps seeing stale ahead/behind counts vs the OLD base until
      // the next tick (30s later) — when the user re-targeted the PR via
      // `gh pr edit --base …`, the lag was painful and confusing.
      let baseTransitionedFrom: string | null = null
      if (pr?.state === 'OPEN' && pr.base) {
        const prevBase = lastKnownPr.get(ws.id)?.base ?? ws.sourceBranch
        if (prevBase !== pr.base) {
          try {
            updateWorkspaceSourceBranch(ws.id, pr.base)
            ws.sourceBranch = pr.base
            baseTransitionedFrom = prevBase
            console.log(`[pr-watcher] PR base changed for workspace '${ws.name}': ${prevBase} → ${pr.base}`)
          } catch (err) {
            console.error(
              `[pr-watcher] updateWorkspaceSourceBranch failed for '${ws.name}':`,
              err instanceof Error ? err.message : err,
            )
            // Leave the cache untouched so the next tick retries — and skip
            // stats too, since they'd be computed against the stale base.
            continue
          }
        }
      }

      // Git stats — best-effort, cached independently of the PR-transition
      // logic below. Its own try/catch so a git failure neither skips PR
      // transitions nor poisons other workspaces.
      try {
        void fetchSourceBranchAsync(ws.worktreePath, ws.sourceBranch).catch(() => {})
        lastKnownGitStats.set(ws.id, await computeGitStats(ws, pr))
      } catch (err) {
        console.error(`[pr-watcher] computeGitStats failed for '${ws.name}':`, err instanceof Error ? err.message : err)
      }

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

        // Only MERGED — closed-without-merge keeps the worktree so the user
        // can inspect / push fixes.
        if (pr.state === 'MERGED') {
          try {
            const { autoPurgeOnPrMerged } = getGlobalSettings()
            if (autoPurgeOnPrMerged) {
              void purgeWorktree(ws.id).catch((err) => {
                console.error(
                  `[pr-watcher] auto-purge failed for '${ws.name}':`,
                  err instanceof Error ? err.message : err,
                )
              })
            }
          } catch (err) {
            console.error(
              `[pr-watcher] auto-purge guard failed for '${ws.name}':`,
              err instanceof Error ? err.message : err,
            )
          }
        }
        continue // do not run base-change detection on a workspace we just archived
      }

      // Review-decision and CI transitions (only on OPEN PRs; first-sight is
      // silent). Reuses the baseline rule from base-change detection: act only
      // on an actual transition between two known states. Each notable
      // transition (changes-requested newly raised, CI newly failing) flips
      // `hasUnread` so the workspace card stands out as "something new to
      // look at" in the drawer — the unread bit persists until the user opens
      // the workspace, matching the existing read/unread UX.
      if (pr.state === 'OPEN' && prev) {
        if (prev.reviewDecision !== 'CHANGES_REQUESTED' && pr.reviewDecision === 'CHANGES_REQUESTED') {
          emitEphemeral(ws.id, 'pr:changes-requested', {
            prNumber: pr.number,
            prUrl: pr.url,
          })
          markUnread(ws.id)
        } else if (prev.reviewDecision === 'CHANGES_REQUESTED' && pr.reviewDecision === 'APPROVED') {
          emitEphemeral(ws.id, 'pr:approved', {
            prNumber: pr.number,
            prUrl: pr.url,
          })
        }
        if (prev.ci.rollup !== 'FAILURE' && pr.ci.rollup === 'FAILURE') {
          markUnread(ws.id)
        }
      }

      // Cache the snapshot for the next tick. For non-OPEN PRs (closed /
      // merged) we preserve the previous `base` if the fresh snapshot is
      // missing one — keeps the OPEN→CLOSED/MERGED archiving logic stable.
      if (pr.state !== 'OPEN' || !pr.base) {
        const next: PrSnapshot = pr.base ? pr : { ...pr, base: prev?.base ?? pr.base }
        lastKnownPr.set(ws.id, next)
        continue
      }
      lastKnownPr.set(ws.id, pr)

      // Emit the base-change event AFTER the snapshot is committed so a
      // sync:response replay on reconnect sees a consistent state. The
      // DB update + ws.sourceBranch mutation already happened above
      // (before computeGitStats).
      if (baseTransitionedFrom !== null) {
        emitEphemeral(ws.id, 'pr:base-changed', {
          oldBase: baseTransitionedFrom,
          newBase: pr.base,
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

  const snap = await getForgeProvider(resolveForge(ws.projectPath)).getPrStatus(ws.worktreePath, ws.workingBranch)
  if (snap === null) {
    lastKnownPr.delete(workspaceId)
    return null
  }
  // Mirror the watcher's base-change detection so a manual refresh fixes a
  // stale `sourceBranch` (typical scenario: user ran `gh pr edit --base …`
  // and clicks the GitPanel refresh button instead of waiting for the next
  // 30s tick). Best-effort: a DB write failure here leaves the snapshot
  // cached but the metadata stale — the watcher will retry on its own.
  if (snap.state === 'OPEN' && snap.base && snap.base !== ws.sourceBranch) {
    try {
      updateWorkspaceSourceBranch(workspaceId, snap.base)
      emitEphemeral(workspaceId, 'pr:base-changed', {
        oldBase: ws.sourceBranch,
        newBase: snap.base,
        prUrl: snap.url,
      })
    } catch (err) {
      console.error(
        `[pr-watcher] updateWorkspaceSourceBranch (refresh) failed for '${ws.name}':`,
        err instanceof Error ? err.message : err,
      )
    }
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
