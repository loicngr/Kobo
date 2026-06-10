// src/server/services/forge/gitlab/provider.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CreatePrOptions, ForgeAvailability, ForgeProvider, PrCiCheck, PrSnapshot } from '../types.js'
import { deriveReadyToMerge } from '../types.js'

const execFileAsync = promisify(execFile)

/** Shape of the relevant fields in `glab mr view --output json`. */
interface RawGlabMr {
  iid: number
  title: string
  web_url: string
  state: string
  target_branch?: string
  author?: { username?: string } | null
  assignees?: Array<{ username: string }>
  reviewers?: Array<{ username: string }>
  labels?: string[]
  updated_at?: string
}

/** Map GitLab MR state to the normalised PrSnapshot state. */
function mapState(state: string): PrSnapshot['state'] {
  if (state === 'merged') return 'MERGED'
  if (state === 'closed') return 'CLOSED'
  return 'OPEN'
}

function mapGlabMrToSnapshot(raw: RawGlabMr): PrSnapshot {
  return {
    number: raw.iid,
    title: raw.title,
    url: raw.web_url,
    state: mapState(raw.state),
    base: raw.target_branch ?? '',
    // GitLab's approval model differs from GitHub review decisions; left null.
    reviewDecision: null,
    author: { login: raw.author?.username ?? '' },
    assignees: (raw.assignees ?? []).map((a) => ({ login: a.username })),
    reviewers: (raw.reviewers ?? []).map((r) => ({ login: r.username, state: 'PENDING' as const })),
    // glab does not expose label colours in the MR view; default to ''.
    labels: (raw.labels ?? []).map((name) => ({ name, color: '' })),
    // ci is enriched by getPrStatus via fetchGlabCi (rollup + per-job checks);
    // this default applies only if that enrichment call fails.
    ci: { rollup: null, checks: [] },
    updatedAt: raw.updated_at ?? '',
    unresolvedReviewThreadsCount: 0,
    readyToMerge: false,
  }
}

/** Map a GitLab pipeline status string to the normalised CI rollup. */
function mapPipelineRollup(status: string | undefined): PrSnapshot['ci']['rollup'] {
  switch (status) {
    case 'failed':
      return 'FAILURE'
    case 'success':
      return 'SUCCESS'
    case 'canceled':
      return 'CANCELLED'
    case 'running':
    case 'pending':
    case 'created':
    case 'preparing':
    case 'scheduled':
    case 'waiting_for_resource':
      return 'PENDING'
    default:
      return null
  }
}

/** Shape of the relevant fields of a job inside `glab ci get -F json`. */
interface RawGlabJob {
  name?: string
  status?: string
  web_url?: string
}

/**
 * Map a GitLab pipeline job to a normalised PrCiCheck. The `status` /
 * `conclusion` pair is chosen so `PrPanel.vue` groups the job correctly:
 * non-`COMPLETED` → pending; `FAILURE`/`CANCELLED` → failed; `SUCCESS` →
 * passed; `SKIPPED`/`NEUTRAL` → skipped.
 */
function mapGlabJobToCheck(job: RawGlabJob): PrCiCheck {
  let status = 'IN_PROGRESS'
  let conclusion: string | null = null
  switch (job.status) {
    case 'failed':
      status = 'COMPLETED'
      conclusion = 'FAILURE'
      break
    case 'canceled':
      status = 'COMPLETED'
      conclusion = 'CANCELLED'
      break
    case 'success':
      status = 'COMPLETED'
      conclusion = 'SUCCESS'
      break
    case 'skipped':
      status = 'COMPLETED'
      conclusion = 'SKIPPED'
      break
    case 'manual':
      status = 'COMPLETED'
      conclusion = 'NEUTRAL'
      break
    default:
      // created / pending / running / preparing / scheduled /
      // waiting_for_resource / unknown — still in flight.
      break
  }
  return { name: job.name ?? '', conclusion, status, detailsUrl: job.web_url ?? null }
}

/**
 * Best-effort latest-pipeline CI summary for a branch via `glab ci get`. The
 * single JSON response carries both the pipeline `status` (the rollup) and a
 * `jobs` array (the per-check detail). Never throws — a branch with no
 * pipeline (or any glab error) yields `{ rollup: null, checks: [] }` so the
 * caller can still return the MR snapshot.
 */
async function fetchGlabCi(repoPath: string, branch: string): Promise<PrSnapshot['ci']> {
  try {
    const { stdout } = await execFileAsync('glab', ['ci', 'get', '-b', branch, '-F', 'json'], {
      cwd: repoPath,
      encoding: 'utf-8',
    })
    const raw = stdout.trim()
    if (!raw) return { rollup: null, checks: [] }
    const pipeline = JSON.parse(raw) as { status?: string; jobs?: RawGlabJob[] }
    return {
      rollup: mapPipelineRollup(pipeline.status),
      checks: (pipeline.jobs ?? []).map(mapGlabJobToCheck),
    }
  } catch {
    return { rollup: null, checks: [] }
  }
}

function availabilityFromError(err: unknown): ForgeAvailability {
  const code = (err as { code?: string }).code
  if (code === 'ENOENT') return { available: false, reason: 'cli_missing' }
  const msg = (err as Error).message?.toLowerCase() ?? ''
  if (msg.includes('not authenticated') || msg.includes('glab auth login')) {
    return { available: false, reason: 'not_authenticated' }
  }
  return { available: false }
}

export const gitlabProvider: ForgeProvider = {
  id: 'gitlab',
  capabilities: { canCreatePr: true, canChangePrBase: true, requestTermShort: 'MR' },

  async isAvailable(repoPath: string): Promise<ForgeAvailability> {
    try {
      await execFileAsync('glab', ['auth', 'status'], { cwd: repoPath, encoding: 'utf-8' })
      return { available: true }
    } catch (err) {
      return availabilityFromError(err)
    }
  },

  async getPrStatus(repoPath: string, branch: string): Promise<PrSnapshot | null> {
    try {
      const { stdout } = await execFileAsync('glab', ['mr', 'view', branch, '--output', 'json'], {
        cwd: repoPath,
        encoding: 'utf-8',
      })
      const raw = stdout.trim()
      if (!raw) return null
      const snapshot = mapGlabMrToSnapshot(JSON.parse(raw) as RawGlabMr)
      snapshot.ci = await fetchGlabCi(repoPath, branch)
      snapshot.readyToMerge = deriveReadyToMerge(snapshot)
      return snapshot
    } catch {
      return null
    }
  },

  async createPr(repoPath: string, opts: CreatePrOptions): Promise<{ url: string; number: number }> {
    const { stdout } = await execFileAsync(
      'glab',
      [
        'mr',
        'create',
        '--source-branch',
        opts.head,
        '--target-branch',
        opts.base,
        '--title',
        opts.title,
        '--description',
        opts.body,
        '--yes',
      ],
      { cwd: repoPath, encoding: 'utf-8' },
    )
    const match = stdout.match(/https?:\/\/[^\s]+\/-\/merge_requests\/(\d+)/)
    if (!match) throw new Error('Could not parse MR URL from glab output')
    return { url: match[0], number: Number.parseInt(match[1], 10) }
  },

  async changePrBase(repoPath: string, base: string): Promise<void> {
    await execFileAsync('glab', ['mr', 'update', '--target-branch', base], { cwd: repoPath, encoding: 'utf-8' })
  },
}
