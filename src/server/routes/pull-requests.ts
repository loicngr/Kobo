import { Hono } from 'hono'
import { getForgeProvider } from '../services/forge/registry.js'
import { resolveForge } from '../services/forge/resolve.js'
import type { PullRequestFilter, PullRequestSummary } from '../services/forge/types.js'
import * as prCheckout from '../services/pr-checkout-service.js'
import { listWorkspaces } from '../services/workspace-service.js'

const app = new Hono()

const FILTERS: PullRequestFilter[] = ['all', 'mine', 'review-requested']

/** Map worktree path -> workspace id, keeping the service free of DB access. */
function attachedWorktreePaths(workspaces?: ReturnType<typeof listWorkspaces>): Map<string, string> {
  const map = new Map<string, string>()
  for (const w of workspaces ?? listWorkspaces(true)) {
    if (w.worktreePath) map.set(w.worktreePath, w.id)
  }
  return map
}

app.get('/', async (c) => {
  try {
    const projectPath = c.req.query('projectPath')
    if (!projectPath) return c.json({ error: 'Missing required field: projectPath' }, 400)

    const provider = getForgeProvider(resolveForge(projectPath))
    if (!provider.capabilities.canListPullRequests) {
      return c.json({ error: 'This project has no forge that can list pull requests' }, 403)
    }

    const rawFilter = c.req.query('filter') as PullRequestFilter | undefined
    const page = await provider.listPullRequests(projectPath, {
      filter: rawFilter && FILTERS.includes(rawFilter) ? rawFilter : 'all',
      search: c.req.query('search') || undefined,
      cursor: c.req.query('cursor') || null,
      perPage: Number(c.req.query('perPage') ?? 25),
    })
    return c.json(page)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

app.post('/diagnose', async (c) => {
  try {
    const { projectPath, prNumber, worktreesPath } = await c.req.json<{
      projectPath: string
      prNumber: number
      worktreesPath?: string | null
    }>()
    if (!projectPath || !prNumber) {
      return c.json({ error: 'Missing required fields: projectPath, prNumber' }, 400)
    }

    const provider = getForgeProvider(resolveForge(projectPath))
    const availability = await provider.isAvailable(projectPath)

    if (!availability.available) {
      // The forge can't be reached, so we have no way to resolve the PR's
      // head branch. Return a minimal report early instead of diagnosing a
      // fake empty branch name, which would produce a nonsensical report.
      const report: prCheckout.PrCheckoutReport = {
        projectPath,
        headBranch: '',
        targetWorktreePath: '',
        blockers: [{ kind: 'forge-unavailable', reason: availability.reason ?? 'cli_missing' }],
        workspace: { state: 'none' },
        worktree: { state: 'none' },
        localChanges: { present: false, modified: 0, staged: 0, untracked: 0 },
        ongoingOperation: null,
        branch: { state: 'absent' },
      }
      return c.json({ report, pr: null, fingerprint: prCheckout.computeFingerprint(report) })
    }

    // Page through the full list — a PR the user explicitly diagnosed by
    // number must never come back "not found" just for sitting past the
    // first 100 (by recency) results.
    let pr: PullRequestSummary | undefined
    let cursor: string | null = null
    do {
      const page = await provider.listPullRequests(projectPath, { filter: 'all', perPage: 100, cursor })
      pr = page.items.find((item) => item.number === prNumber)
      cursor = page.nextCursor
    } while (!pr && cursor !== null)
    if (!pr) return c.json({ error: `Pull request #${prNumber} not found` }, 404)

    const workspaces = listWorkspaces(true)
    const report = prCheckout.diagnoseLocalState(
      projectPath,
      pr.headBranch,
      worktreesPath ?? null,
      attachedWorktreePaths(workspaces),
      workspaces,
    )

    if (pr.isFork) report.blockers.push({ kind: 'fork-pr' })

    return c.json({ report, pr, fingerprint: prCheckout.computeFingerprint(report) })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

app.post('/resolve', async (c) => {
  try {
    const body = await c.req.json<{
      projectPath: string
      prNumber: number
      headBranch: string
      baseBranch: string
      worktreesPath?: string | null
      decisions: prCheckout.PrCheckoutDecisions
      fingerprint: string
    }>()
    if (!body.projectPath || !body.fingerprint) {
      return c.json({ error: 'Missing required fields: projectPath, fingerprint' }, 400)
    }

    const workspaces = listWorkspaces(true)
    const result = await prCheckout.resolvePrCheckout({
      projectPath: body.projectPath,
      headBranch: body.headBranch,
      baseBranch: body.baseBranch,
      worktreesPath: body.worktreesPath ?? null,
      decisions: body.decisions ?? {},
      fingerprint: body.fingerprint,
      workspaces,
      attachedPaths: attachedWorktreePaths(workspaces),
    })
    return c.json(result)
  } catch (err) {
    if (err instanceof prCheckout.StaleDiagnosisError) {
      return c.json({ error: err.message, report: err.report }, 409)
    }
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 422)
  }
})

export default app
