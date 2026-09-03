// src/server/services/forge/github/provider.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseCliJson } from '../parse-cli-json.js'
import type {
  CreatePrOptions,
  ForgeAvailability,
  ForgeProvider,
  ListPullRequestsOptions,
  ListPullRequestsResult,
  PrCiCheck,
  PrReviewer,
  PrSnapshot,
  PullRequestSummary,
} from '../types.js'
import { deriveReadyToMerge } from '../types.js'

const execFileAsync = promisify(execFile)
const CLI_TIMEOUT_MS = 30_000

function cliOptions(repoPath: string) {
  return { cwd: repoPath, encoding: 'utf-8' as const, timeout: CLI_TIMEOUT_MS }
}

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
  'mergeable',
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
  mergeable?: string
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
  const mergeable: PrSnapshot['mergeable'] =
    raw.mergeable === 'CONFLICTING' || raw.mergeable === 'MERGEABLE' || raw.mergeable === 'UNKNOWN'
      ? raw.mergeable
      : null
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
    mergeable,
    readyToMerge: deriveReadyToMerge({ state, ci: { rollup, checks }, reviewDecision, reviewers, mergeable }),
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

const GH_LIST_QUERY = `
query($q:String!,$first:Int!,$after:String){
  search(query:$q, type:ISSUE, first:$first, after:$after){
    pageInfo{ hasNextPage endCursor }
    nodes{
      ... on PullRequest {
        number title url isDraft updatedAt
        author{ login }
        headRefName baseRefName isCrossRepository reviewDecision
        commits(last:1){ nodes{ commit{ statusCheckRollup{ state } } } }
      }
    }
  }
}`

/** Build the `search` qualifier string. Exported for tests. */
export function buildGithubSearchQuery(nameWithOwner: string, opts: ListPullRequestsOptions): string {
  const parts = [`repo:${nameWithOwner}`, 'is:pr', 'is:open']
  if (opts.filter === 'mine') parts.push('author:@me')
  if (opts.filter === 'review-requested') parts.push('review-requested:@me')
  parts.push('sort:updated-desc')
  const query = parts.join(' ')
  const search = opts.search?.trim()
  return search ? `${query} ${search}` : query
}

/** Map a raw `gh api graphql` response into a page. Exported for tests. */
export function mapGithubSearchPage(raw: unknown): ListPullRequestsResult {
  const search = record(record(record(raw).data).search)
  const pageInfo = record(search.pageInfo)
  const nodes = Array.isArray(search.nodes) ? search.nodes : []

  const items: PullRequestSummary[] = nodes.map((node) => {
    const pr = record(node)
    const commitNodes = Array.isArray(record(pr.commits).nodes) ? (record(pr.commits).nodes as unknown[]) : []
    const rollup = record(record(record(commitNodes[0]).commit).statusCheckRollup).state
    const decision = pr.reviewDecision
    return {
      number: typeof pr.number === 'number' ? pr.number : 0,
      title: typeof pr.title === 'string' ? pr.title : '',
      url: typeof pr.url === 'string' ? pr.url : '',
      author: typeof record(pr.author).login === 'string' ? (record(pr.author).login as string) : '',
      headBranch: typeof pr.headRefName === 'string' ? pr.headRefName : '',
      baseBranch: typeof pr.baseRefName === 'string' ? pr.baseRefName : '',
      isFork: pr.isCrossRepository === true,
      isDraft: pr.isDraft === true,
      updatedAt: typeof pr.updatedAt === 'string' ? pr.updatedAt : '',
      ci: typeof rollup === 'string' ? (rollup as PrSnapshot['ci']['rollup']) : null,
      reviewDecision: typeof decision === 'string' ? (decision as PrSnapshot['reviewDecision']) : null,
    }
  })

  return { items, nextCursor: pageInfo.hasNextPage === true ? String(pageInfo.endCursor ?? '') || null : null }
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
  capabilities: {
    canCreatePr: true,
    canChangePrBase: true,
    canMergeRequest: true,
    canDeleteRemoteBranch: true,
    canListPullRequests: true,
    requestTermShort: 'PR',
  },

  async isAvailable(repoPath: string): Promise<ForgeAvailability> {
    try {
      await execFileAsync('gh', ['auth', 'status'], cliOptions(repoPath))
      return { available: true }
    } catch (err) {
      return availabilityFromError(err)
    }
  },

  async getPrStatus(repoPath: string, branch: string): Promise<PrSnapshot | null> {
    try {
      const { stdout } = await execFileAsync('gh', ['pr', 'view', branch, '--json', GH_PR_FIELDS], cliOptions(repoPath))
      const raw = stdout.trim()
      if (!raw) return null
      return mapGhPrToSnapshot(parseCliJson<RawGhPr>(raw, 'gh pr view'))
    } catch {
      return null
    }
  },

  async createPr(repoPath: string, opts: CreatePrOptions): Promise<{ url: string; number: number }> {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'create', '--base', opts.base, '--head', opts.head, '--title', opts.title, '--body', opts.body],
      cliOptions(repoPath),
    )
    const match = stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/)
    if (!match) throw new Error('Could not parse PR URL from gh output')
    return { url: match[0], number: Number.parseInt(match[1], 10) }
  },

  async changePrBase(repoPath: string, base: string): Promise<void> {
    await execFileAsync('gh', ['pr', 'edit', '--base', base], cliOptions(repoPath))
  },

  async mergeRequest(repoPath: string, number: number): Promise<void> {
    await execFileAsync('gh', ['pr', 'merge', String(number), '--merge'], cliOptions(repoPath))
  },
  async deleteRemoteBranch(repoPath: string, branch: string): Promise<void> {
    await execFileAsync('git', ['push', 'origin', '--delete', branch], cliOptions(repoPath))
  },

  async listPullRequests(repoPath: string, opts: ListPullRequestsOptions): Promise<ListPullRequestsResult> {
    const { stdout: repoJson } = await execFileAsync(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner'],
      cliOptions(repoPath),
    )
    const nameWithOwner = String(
      parseCliJson<{ nameWithOwner?: unknown }>(repoJson, 'gh repo view').nameWithOwner ?? '',
    )
    if (!nameWithOwner) throw new Error('Could not determine the GitHub repository for this path')

    const args = [
      'api',
      'graphql',
      '-f',
      `query=${GH_LIST_QUERY}`,
      '-f',
      `q=${buildGithubSearchQuery(nameWithOwner, opts)}`,
      '-F',
      `first=${opts.perPage}`,
    ]
    if (opts.cursor) args.push('-f', `after=${opts.cursor}`)

    const { stdout } = await execFileAsync('gh', args, cliOptions(repoPath))
    return mapGithubSearchPage(parseCliJson(stdout, 'gh api graphql (list PRs)'))
  },
}
