import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getGlobalSettings } from '../../settings-service.js'
import type { CreatePrOptions, ForgeAvailability, ForgeProvider, PrCiCheck, PrReviewer, PrSnapshot } from '../types.js'
import { deriveReadyToMerge } from '../types.js'

const execFileAsync = promisify(execFile)

type RawRecord = Record<string, unknown>
type BitbucketTarget = { workspace: string; repo: string; context: string | null }

function record(value: unknown): RawRecord {
  return value !== null && typeof value === 'object' ? (value as RawRecord) : {}
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function branch(raw: RawRecord, cloudKey: 'source' | 'destination', dcKey: 'fromRef' | 'toRef'): string {
  const cloud = record(record(raw[cloudKey]).branch)
  return string(cloud.name) || string(record(raw[dcKey]).displayId)
}

function login(raw: unknown): string {
  const user = record(raw)
  return string(user.nickname) || string(user.username) || string(user.name) || string(user.display_name)
}

function url(raw: RawRecord): string {
  const links = record(raw.links)
  const html = record(links.html)
  if (string(html.href)) return string(html.href)
  const self = links.self
  if (Array.isArray(self)) return string(record(self[0]).href)
  return ''
}

function mapState(value: string): PrSnapshot['state'] {
  const state = value.toUpperCase()
  if (state === 'MERGED') return 'MERGED'
  if (state === 'DECLINED' || state === 'CLOSED' || state === 'SUPERSEDED') return 'CLOSED'
  return 'OPEN'
}

function mapReviewers(raw: RawRecord): PrReviewer[] {
  const result = new Map<string, PrReviewer['state']>()
  const add = (candidate: unknown, fallback: PrReviewer['state']): void => {
    const entry = record(candidate)
    const reviewerLogin = login(entry.user) || login(entry)
    if (!reviewerLogin) return
    const rawState = string(entry.status || entry.state).toUpperCase()
    const state: PrReviewer['state'] =
      entry.approved === true || rawState === 'APPROVED'
        ? 'APPROVED'
        : rawState === 'NEEDS_WORK' || rawState === 'CHANGES_REQUESTED'
          ? 'CHANGES_REQUESTED'
          : fallback
    result.set(reviewerLogin, state)
  }
  for (const reviewer of Array.isArray(raw.reviewers) ? raw.reviewers : []) add(reviewer, 'PENDING')
  for (const participant of Array.isArray(raw.participants) ? raw.participants : []) add(participant, 'COMMENTED')
  return [...result].map(([reviewerLogin, state]) => ({ login: reviewerLogin, state }))
}

function mapCheck(raw: unknown): PrCiCheck {
  const check = record(raw)
  const state = string(check.state || check.status).toUpperCase()
  const completed = ['SUCCESSFUL', 'SUCCESS', 'FAILED', 'FAILURE', 'CANCELLED', 'CANCELED'].includes(state)
  const conclusion = ['SUCCESSFUL', 'SUCCESS'].includes(state)
    ? 'SUCCESS'
    : ['FAILED', 'FAILURE'].includes(state)
      ? 'FAILURE'
      : ['CANCELLED', 'CANCELED'].includes(state)
        ? 'CANCELLED'
        : null
  return {
    name: string(check.name) || string(check.key),
    status: completed ? 'COMPLETED' : 'IN_PROGRESS',
    conclusion,
    detailsUrl: string(check.url) || null,
  }
}

function mapBktPr(raw: RawRecord, ci: PrSnapshot['ci'] = { rollup: null, checks: [] }): PrSnapshot {
  const state = mapState(string(raw.state))
  const reviewers = mapReviewers(raw)
  const reviewDecision = reviewers.some((reviewer) => reviewer.state === 'CHANGES_REQUESTED')
    ? 'CHANGES_REQUESTED'
    : null
  const mergeable: PrSnapshot['mergeable'] = raw.open === false ? 'CONFLICTING' : null
  return {
    number: number(raw.id),
    title: string(raw.title),
    url: url(raw),
    state,
    base: branch(raw, 'destination', 'toRef'),
    reviewDecision,
    author: { login: login(raw.author) },
    assignees: [],
    reviewers,
    labels: [],
    ci,
    updatedAt: string(raw.updated_on) || string(raw.updatedAt) || String(raw.updatedDate ?? ''),
    unresolvedReviewThreadsCount: 0,
    mergeable,
    readyToMerge: deriveReadyToMerge({ state, ci, reviewDecision, reviewers, mergeable }),
  }
}

function availabilityFromError(err: unknown): ForgeAvailability {
  const code = (err as { code?: string }).code
  if (code === 'ENOENT') return { available: false, reason: 'cli_missing' }
  const message = (err as Error).message?.toLowerCase() ?? ''
  if (
    message.includes('no active context') ||
    message.includes('not authenticated') ||
    message.includes('auth login')
  ) {
    return { available: false, reason: 'not_authenticated' }
  }
  return { available: false }
}

function parseBitbucketRemote(remote: string): Omit<BitbucketTarget, 'context'> | null {
  const match = remote.trim().match(/bitbucket(?:\.org)?[/:]([^/\s:]+)\/([^/\s]+?)(?:\.git)?\/?$/i)
  if (!match) return null
  return { workspace: match[1], repo: match[2] }
}

function contextName(workspace: string, repo: string): string {
  return `kobo-${workspace}-${repo}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-')
}

function bktArgs(target: BitbucketTarget, args: string[]): string[] {
  return target.context ? ['--context', target.context, ...args] : args
}

function bktEnv(): NodeJS.ProcessEnv {
  try {
    const settings = getGlobalSettings()
    if (settings.bitbucketToken) {
      return {
        ...process.env,
        BKT_HOST: 'https://bitbucket.org',
        BKT_TOKEN: settings.bitbucketToken,
        BKT_USERNAME: settings.bitbucketUsername || process.env.BKT_USERNAME,
      }
    }
  } catch {
    // Settings are deliberately uninitialized in isolated forge tests.
  }
  return process.env
}

function bktOptions(repoPath: string) {
  return { cwd: repoPath, encoding: 'utf-8' as const, env: bktEnv() }
}

async function resolveTarget(repoPath: string): Promise<BitbucketTarget> {
  const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
    cwd: repoPath,
    encoding: 'utf-8',
  })
  const target = parseBitbucketRemote(stdout)
  if (!target) throw new Error('Could not determine Bitbucket workspace and repository from the origin remote')
  // BKT_TOKEN is the CLI's documented headless mode. It deliberately avoids
  // keyring and context access, which cannot prompt from the Kobo server.
  if (bktEnv().BKT_TOKEN) return { ...target, context: null }

  const { stdout: contextOutput } = await execFileAsync('bkt', ['context', 'list', '--json'], {
    cwd: repoPath,
    encoding: 'utf-8',
  })
  const contexts = record(JSON.parse(contextOutput)).contexts
  const existing = (Array.isArray(contexts) ? contexts : [])
    .map(record)
    .find((context) => string(context.workspace) === target.workspace && string(context.default_repo) === target.repo)
  if (existing && string(existing.name)) return { ...target, context: string(existing.name) }

  const { stdout: authOutput } = await execFileAsync('bkt', ['auth', 'status', '--json'], {
    cwd: repoPath,
    encoding: 'utf-8',
  })
  const hosts = record(JSON.parse(authOutput)).hosts
  const host = (Array.isArray(hosts) ? hosts : []).map(record).find((item) => string(item.kind) === 'cloud')
  const hostKey = string(host?.key)
  if (!hostKey) throw new Error('No authenticated Bitbucket Cloud host found; run bkt auth login first')

  const context = contextName(target.workspace, target.repo)
  await execFileAsync(
    'bkt',
    ['context', 'create', context, '--host', hostKey, '--workspace', target.workspace, '--repo', target.repo],
    { cwd: repoPath, encoding: 'utf-8' },
  )
  return { ...target, context }
}

function targetArgs(target: BitbucketTarget): string[] {
  return ['--workspace', target.workspace, '--repo', target.repo]
}

async function fetchCi(repoPath: string, number: number, target: BitbucketTarget): Promise<PrSnapshot['ci']> {
  try {
    const { stdout } = await execFileAsync(
      'bkt',
      bktArgs(target, ['pr', 'checks', String(number), ...targetArgs(target), '--json']),
      bktOptions(repoPath),
    )
    const statuses = record(JSON.parse(stdout)).statuses
    const checks = (Array.isArray(statuses) ? statuses : []).map(mapCheck)
    const rollup: PrSnapshot['ci']['rollup'] =
      checks.length === 0
        ? null
        : checks.some((check) => check.conclusion === 'FAILURE')
          ? 'FAILURE'
          : checks.some((check) => check.conclusion === 'CANCELLED')
            ? 'CANCELLED'
            : checks.some((check) => check.status !== 'COMPLETED')
              ? 'PENDING'
              : 'SUCCESS'
    return { rollup, checks }
  } catch {
    return { rollup: null, checks: [] }
  }
}

export const bitbucketProvider: ForgeProvider = {
  id: 'bitbucket-community',
  capabilities: {
    canCreatePr: true,
    // bkt 0.30 does not expose a target-branch edit command.
    canChangePrBase: false,
    canMergeRequest: true,
    canDeleteRemoteBranch: true,
    requestTermShort: 'PR',
  },

  async isAvailable(repoPath: string): Promise<ForgeAvailability> {
    try {
      const { stdout } = await execFileAsync('bkt', ['auth', 'status', '--json'], bktOptions(repoPath))
      const status = record(JSON.parse(stdout))
      const hosts = status.hosts
      if ((Array.isArray(hosts) && hosts.length > 0) || bktEnv().BKT_TOKEN) return { available: true }
      return { available: false, reason: 'not_authenticated' }
    } catch (err) {
      return availabilityFromError(err)
    }
  },

  async getPrStatus(repoPath: string, branchName: string): Promise<PrSnapshot | null> {
    try {
      const target = await resolveTarget(repoPath)
      let match: RawRecord | undefined
      // The post-merge workflow asks for the final state before offering remote
      // branch deletion, so do not stop at OPEN requests.
      for (const state of ['OPEN', 'MERGED', 'DECLINED']) {
        const { stdout: listOutput } = await execFileAsync(
          'bkt',
          bktArgs(target, ['pr', 'list', '--state', state, '--limit', '50', ...targetArgs(target), '--json']),
          bktOptions(repoPath),
        )
        const pullRequests = record(JSON.parse(listOutput)).pull_requests
        match = (Array.isArray(pullRequests) ? pullRequests : [])
          .map(record)
          .find((pullRequest) => branch(pullRequest, 'source', 'fromRef') === branchName)
        if (match) break
      }
      if (!match) return null
      const { stdout: viewOutput } = await execFileAsync(
        'bkt',
        bktArgs(target, ['pr', 'view', String(number(match.id)), ...targetArgs(target), '--json']),
        bktOptions(repoPath),
      )
      const raw = record(record(JSON.parse(viewOutput)).pull_request)
      if (!number(raw.id)) return null
      const ci = await fetchCi(repoPath, number(raw.id), target)
      return mapBktPr(raw, ci)
    } catch {
      return null
    }
  },

  async createPr(repoPath: string, opts: CreatePrOptions): Promise<{ url: string; number: number }> {
    const target = await resolveTarget(repoPath)
    const { stdout } = await execFileAsync(
      'bkt',
      bktArgs(target, [
        'pr',
        'create',
        '--source',
        opts.head,
        '--target',
        opts.base,
        '--title',
        opts.title,
        '--description',
        opts.body,
        ...targetArgs(target),
        '--json',
      ]),
      bktOptions(repoPath),
    )
    const raw = record(JSON.parse(stdout))
    const prNumber = number(raw.id)
    const prUrl = string(raw.url)
    if (!prNumber || !prUrl) throw new Error('Could not parse PR URL from bkt output')
    return { url: prUrl, number: prNumber }
  },

  async changePrBase(): Promise<void> {
    throw new Error('Changing a Bitbucket PR base branch is not supported by the installed bkt CLI')
  },

  async mergeRequest(repoPath: string, number: number): Promise<void> {
    const target = await resolveTarget(repoPath)
    await execFileAsync(
      'bkt',
      bktArgs(target, ['pr', 'merge', String(number), '--close-source=false', ...targetArgs(target)]),
      bktOptions(repoPath),
    )
  },

  async deleteRemoteBranch(repoPath: string, branchName: string): Promise<void> {
    await execFileAsync('git', ['push', 'origin', '--delete', branchName], { cwd: repoPath, encoding: 'utf-8' })
  },
}
