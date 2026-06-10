// src/server/services/forge/github/provider.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CreatePrOptions, ForgeAvailability, ForgeProvider, PrCiCheck, PrReviewer, PrSnapshot } from '../types.js'
import { deriveReadyToMerge } from '../types.js'

const execFileAsync = promisify(execFile)

// NOTE: `reviewThreads` is intentionally NOT in this list.
// `gh pr view --json reviewThreads` is rejected with `Unknown JSON field`
// — there is no stable `gh` version that exposes it. Until upstream adds it,
// `unresolvedReviewThreadsCount` stays at 0. `reviewThreads` is kept in the
// `RawGhPr` shape only so the mapper code stays forward-compatible.
const GH_PR_FIELDS = [
  'number',
  'title',
  'url',
  'state',
  'baseRefName',
  'reviewDecision',
  'author',
  'assignees',
  'labels',
  'latestReviews',
  'reviewRequests',
  'statusCheckRollup',
  'updatedAt',
].join(',')

interface RawGhPr {
  number: number
  title: string
  url: string
  state: string
  baseRefName?: string
  reviewDecision?: string | null
  author?: { login?: string } | null
  assignees?: Array<{ login: string }>
  labels?: Array<{ name: string; color: string }>
  latestReviews?: Array<{ author: { login: string }; state: string }>
  reviewRequests?: Array<{ login: string }>
  reviewThreads?: Array<{ isResolved: boolean }>
  statusCheckRollup?: Array<{ name: string; conclusion: string | null; status: string; detailsUrl: string | null }>
  updatedAt?: string
}

function mapGhPrToSnapshot(raw: RawGhPr): PrSnapshot {
  const reviewers: PrReviewer[] = []
  const seen = new Set<string>()
  for (const r of raw.latestReviews ?? []) {
    const login = r.author?.login
    if (!login || seen.has(login)) continue
    seen.add(login)
    reviewers.push({ login, state: (r.state as PrReviewer['state']) ?? 'COMMENTED' })
  }
  for (const r of raw.reviewRequests ?? []) {
    if (!r.login || seen.has(r.login)) continue
    seen.add(r.login)
    reviewers.push({ login: r.login, state: 'PENDING' })
  }
  const checks: PrCiCheck[] = (raw.statusCheckRollup ?? []).map((c) => ({
    name: c.name,
    conclusion: c.conclusion ?? null,
    status: c.status,
    detailsUrl: c.detailsUrl ?? null,
  }))
  let rollup: PrSnapshot['ci']['rollup'] = null
  if (checks.length > 0) {
    if (checks.some((c) => c.conclusion === 'FAILURE')) rollup = 'FAILURE'
    else if (checks.some((c) => c.status !== 'COMPLETED')) rollup = 'PENDING'
    else rollup = 'SUCCESS'
  }
  const unresolvedReviewThreadsCount = (raw.reviewThreads ?? []).reduce((a, t) => a + (t.isResolved ? 0 : 1), 0)
  const state = raw.state as PrSnapshot['state']
  const reviewDecision = (raw.reviewDecision as PrSnapshot['reviewDecision']) ?? null
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state,
    base: raw.baseRefName ?? '',
    reviewDecision,
    author: { login: raw.author?.login ?? '' },
    assignees: (raw.assignees ?? []).map((a) => ({ login: a.login })),
    reviewers,
    labels: (raw.labels ?? []).map((l) => ({ name: l.name, color: l.color })),
    ci: { rollup, checks },
    updatedAt: raw.updatedAt ?? '',
    unresolvedReviewThreadsCount,
    readyToMerge: deriveReadyToMerge({ state, ci: { rollup, checks }, reviewDecision, reviewers }),
  }
}

/** Map an execFile rejection to a ForgeAvailability reason. */
function availabilityFromError(err: unknown): ForgeAvailability {
  const code = (err as { code?: string }).code
  if (code === 'ENOENT') return { available: false, reason: 'cli_missing' }
  const msg = (err as Error).message?.toLowerCase() ?? ''
  if (msg.includes('not logged in') || msg.includes('gh auth login')) {
    return { available: false, reason: 'not_authenticated' }
  }
  return { available: false }
}

export const githubProvider: ForgeProvider = {
  id: 'github',
  capabilities: { canCreatePr: true, canChangePrBase: true, requestTermShort: 'PR' },

  async isAvailable(repoPath: string): Promise<ForgeAvailability> {
    try {
      await execFileAsync('gh', ['auth', 'status'], { cwd: repoPath, encoding: 'utf-8' })
      return { available: true }
    } catch (err) {
      return availabilityFromError(err)
    }
  },

  async getPrStatus(repoPath: string, branch: string): Promise<PrSnapshot | null> {
    try {
      const { stdout } = await execFileAsync('gh', ['pr', 'view', branch, '--json', GH_PR_FIELDS], {
        cwd: repoPath,
        encoding: 'utf-8',
      })
      const raw = stdout.trim()
      if (!raw) return null
      return mapGhPrToSnapshot(JSON.parse(raw) as RawGhPr)
    } catch {
      return null
    }
  },

  async createPr(repoPath: string, opts: CreatePrOptions): Promise<{ url: string; number: number }> {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'create', '--base', opts.base, '--head', opts.head, '--title', opts.title, '--body', opts.body],
      { cwd: repoPath, encoding: 'utf-8' },
    )
    const match = stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/)
    if (!match) throw new Error('Could not parse PR URL from gh output')
    return { url: match[0], number: Number.parseInt(match[1], 10) }
  },

  async changePrBase(repoPath: string, base: string): Promise<void> {
    await execFileAsync('gh', ['pr', 'edit', '--base', base], { cwd: repoPath, encoding: 'utf-8' })
  },
}
