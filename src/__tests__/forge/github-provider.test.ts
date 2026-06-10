// src/__tests__/forge/github-provider.test.ts
import { describe, expect, it, vi } from 'vitest'

const execFileMock = vi.fn()
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => {
    // node's promisify(execFile) calls the callback form.
    const cb = args[args.length - 1] as (e: unknown, r: { stdout: string }) => void
    execFileMock(args[0], args[1])
      .then((stdout: string) => cb(null, { stdout }))
      .catch((e: unknown) => cb(e, { stdout: '' }))
  },
}))

import { githubProvider } from '../../server/services/forge/github/provider.js'

describe('github forge provider', () => {
  it('isAvailable reports cli_missing on ENOENT', async () => {
    const err = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
    execFileMock.mockRejectedValueOnce(err)
    expect(await githubProvider.isAvailable('/repo')).toEqual({ available: false, reason: 'cli_missing' })
  })

  it('createPr parses url and number from gh output', async () => {
    execFileMock.mockResolvedValueOnce('https://github.com/o/r/pull/42\n')
    const res = await githubProvider.createPr('/repo', { base: 'main', head: 'feat/x', title: 'T', body: 'B' })
    expect(res).toEqual({ url: 'https://github.com/o/r/pull/42', number: 42 })
  })

  it('declares PR terminology and capabilities', () => {
    expect(githubProvider.capabilities).toEqual({
      canCreatePr: true,
      canChangePrBase: true,
      requestTermShort: 'PR',
    })
  })

  it('isAvailable returns available when gh auth status succeeds', async () => {
    execFileMock.mockResolvedValueOnce('Logged in to github.com\n')
    expect(await githubProvider.isAvailable('/repo')).toEqual({ available: true })
  })

  it('getPrStatus maps gh pr view json to a PrSnapshot', async () => {
    const rawPr = {
      number: 3,
      title: 'My PR',
      url: 'https://github.com/o/r/pull/3',
      state: 'OPEN',
      baseRefName: 'main',
      reviewDecision: 'REVIEW_REQUIRED',
      author: { login: 'alice' },
      assignees: [{ login: 'bob' }],
      labels: [{ name: 'bug', color: 'ff0000' }],
      latestReviews: [{ author: { login: 'carol' }, state: 'APPROVED' }],
      reviewRequests: [{ login: 'dave' }],
      statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS', status: 'COMPLETED', detailsUrl: null }],
      updatedAt: '2026-05-19T10:00:00Z',
    }
    execFileMock.mockResolvedValueOnce(JSON.stringify(rawPr))
    const snap = await githubProvider.getPrStatus('/repo', 'feat/x')
    expect(snap).toMatchObject({
      number: 3,
      title: 'My PR',
      url: 'https://github.com/o/r/pull/3',
      state: 'OPEN',
      base: 'main',
      reviewDecision: 'REVIEW_REQUIRED',
      author: { login: 'alice' },
      ci: { rollup: 'SUCCESS' },
      unresolvedReviewThreadsCount: 0,
    })
    expect(snap?.reviewers).toEqual([
      { login: 'carol', state: 'APPROVED' },
      { login: 'dave', state: 'PENDING' },
    ])
  })

  it('CI rollup is null when statusCheckRollup is absent', async () => {
    const rawPr = {
      number: 10,
      title: 'No CI PR',
      url: 'https://github.com/o/r/pull/10',
      state: 'OPEN',
    }
    execFileMock.mockResolvedValueOnce(JSON.stringify(rawPr))
    const snap = await githubProvider.getPrStatus('/repo', 'feat/x')
    expect(snap?.ci.rollup).toBeNull()
    expect(snap?.ci.checks).toEqual([])
  })

  it('CI rollup is PENDING when a check is not COMPLETED', async () => {
    const rawPr = {
      number: 11,
      title: 'In Progress PR',
      url: 'https://github.com/o/r/pull/11',
      state: 'OPEN',
      statusCheckRollup: [{ name: 'ci', conclusion: null, status: 'IN_PROGRESS', detailsUrl: null }],
    }
    execFileMock.mockResolvedValueOnce(JSON.stringify(rawPr))
    const snap = await githubProvider.getPrStatus('/repo', 'feat/x')
    expect(snap?.ci.rollup).toBe('PENDING')
  })

  it('CI rollup is FAILURE when a check has conclusion FAILURE', async () => {
    const rawPr = {
      number: 12,
      title: 'Failed CI PR',
      url: 'https://github.com/o/r/pull/12',
      state: 'OPEN',
      statusCheckRollup: [{ name: 'ci', conclusion: 'FAILURE', status: 'COMPLETED', detailsUrl: null }],
    }
    execFileMock.mockResolvedValueOnce(JSON.stringify(rawPr))
    const snap = await githubProvider.getPrStatus('/repo', 'feat/x')
    expect(snap?.ci.rollup).toBe('FAILURE')
  })

  it('reviewer dedup — latestReviews wins over reviewRequests for the same login', async () => {
    const rawPr = {
      number: 13,
      title: 'Dedup PR',
      url: 'https://github.com/o/r/pull/13',
      state: 'OPEN',
      latestReviews: [{ author: { login: 'sam' }, state: 'APPROVED' }],
      reviewRequests: [{ login: 'sam' }],
    }
    execFileMock.mockResolvedValueOnce(JSON.stringify(rawPr))
    const snap = await githubProvider.getPrStatus('/repo', 'feat/x')
    expect(snap?.reviewers).toHaveLength(1)
    expect(snap?.reviewers[0]).toEqual({ login: 'sam', state: 'APPROVED' })
  })

  it('readyToMerge is true for an OPEN PR with all-green CI and no blocking review', async () => {
    const rawPr = {
      number: 20,
      title: 'Green PR',
      url: 'https://github.com/o/r/pull/20',
      state: 'OPEN',
      statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS', status: 'COMPLETED', detailsUrl: null }],
    }
    execFileMock.mockResolvedValueOnce(JSON.stringify(rawPr))
    const snap = await githubProvider.getPrStatus('/repo', 'feat/x')
    expect(snap?.readyToMerge).toBe(true)
  })

  it('readyToMerge is false when a reviewer actively requests changes', async () => {
    const rawPr = {
      number: 21,
      title: 'Blocked PR',
      url: 'https://github.com/o/r/pull/21',
      state: 'OPEN',
      reviewDecision: 'CHANGES_REQUESTED',
      latestReviews: [{ author: { login: 'rev' }, state: 'CHANGES_REQUESTED' }],
      statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS', status: 'COMPLETED', detailsUrl: null }],
    }
    execFileMock.mockResolvedValueOnce(JSON.stringify(rawPr))
    const snap = await githubProvider.getPrStatus('/repo', 'feat/x')
    expect(snap?.readyToMerge).toBe(false)
  })

  it('readyToMerge is true when there are no checks (no CI configured)', async () => {
    const rawPr = {
      number: 23,
      title: 'No CI PR',
      url: 'https://github.com/o/r/pull/23',
      state: 'OPEN',
    }
    execFileMock.mockResolvedValueOnce(JSON.stringify(rawPr))
    const snap = await githubProvider.getPrStatus('/repo', 'feat/x')
    expect(snap?.readyToMerge).toBe(true)
  })

  it('readyToMerge is false when CI is still pending', async () => {
    const rawPr = {
      number: 22,
      title: 'Pending PR',
      url: 'https://github.com/o/r/pull/22',
      state: 'OPEN',
      statusCheckRollup: [{ name: 'ci', conclusion: null, status: 'IN_PROGRESS', detailsUrl: null }],
    }
    execFileMock.mockResolvedValueOnce(JSON.stringify(rawPr))
    const snap = await githubProvider.getPrStatus('/repo', 'feat/x')
    expect(snap?.readyToMerge).toBe(false)
  })
})
