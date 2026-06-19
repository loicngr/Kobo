// src/__tests__/forge/gitlab-provider.test.ts
import { describe, expect, it, vi } from 'vitest'

const execFileMock = vi.fn()
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => {
    const cb = args[args.length - 1] as (e: unknown, r: { stdout: string }) => void
    execFileMock(args[0], args[1])
      .then((stdout: string) => cb(null, { stdout }))
      .catch((e: unknown) => cb(e, { stdout: '' }))
  },
}))

import { gitlabProvider } from '../../server/services/forge/gitlab/provider.js'

const MR_JSON = JSON.stringify({
  iid: 12,
  title: 'My MR',
  web_url: 'https://gitlab.com/o/r/-/merge_requests/12',
  state: 'opened',
  target_branch: 'main',
  author: { username: 'alice' },
  assignees: [{ username: 'bob' }],
  reviewers: [{ username: 'carol' }],
  labels: ['bug'],
  updated_at: '2026-05-19T10:00:00Z',
})

describe('gitlab forge provider', () => {
  it('declares MR terminology', () => {
    expect(gitlabProvider.capabilities.requestTermShort).toBe('MR')
  })

  it('getPrStatus maps glab MR json to a PrSnapshot', async () => {
    execFileMock.mockResolvedValueOnce(MR_JSON)
    execFileMock.mockResolvedValueOnce('') // glab ci get — no pipeline
    const snap = await gitlabProvider.getPrStatus('/repo', 'feat/x')
    expect(snap).toMatchObject({
      number: 12,
      title: 'My MR',
      url: 'https://gitlab.com/o/r/-/merge_requests/12',
      state: 'OPEN',
      base: 'main',
      author: { login: 'alice' },
      unresolvedReviewThreadsCount: 0,
    })
    expect(snap?.labels).toEqual([{ name: 'bug', color: '' }])
    expect(snap?.ci.rollup).toBeNull()
  })

  it('getPrStatus returns null when no MR exists', async () => {
    execFileMock.mockRejectedValueOnce(new Error('no merge request'))
    expect(await gitlabProvider.getPrStatus('/repo', 'feat/x')).toBeNull()
  })

  it('isAvailable reports cli_missing on ENOENT', async () => {
    execFileMock.mockRejectedValueOnce(Object.assign(new Error('spawn glab ENOENT'), { code: 'ENOENT' }))
    expect(await gitlabProvider.isAvailable('/repo')).toEqual({ available: false, reason: 'cli_missing' })
  })

  it('createPr returns the MR url and number', async () => {
    execFileMock.mockResolvedValueOnce('https://gitlab.com/o/r/-/merge_requests/99\n')
    const res = await gitlabProvider.createPr('/repo', { base: 'main', head: 'feat/x', title: 'T', body: 'B' })
    expect(res).toEqual({ url: 'https://gitlab.com/o/r/-/merge_requests/99', number: 99 })
  })
})

describe('gitlab forge provider — CI rollup', () => {
  it('maps a failed pipeline to ci.rollup FAILURE', async () => {
    execFileMock.mockResolvedValueOnce(MR_JSON)
    execFileMock.mockResolvedValueOnce(JSON.stringify({ id: 7, status: 'failed' }))
    const snap = await gitlabProvider.getPrStatus('/repo', 'feat/x')
    expect(snap?.ci.rollup).toBe('FAILURE')
  })

  it('maps success / running / canceled pipeline statuses', async () => {
    for (const [status, rollup] of [
      ['success', 'SUCCESS'],
      ['running', 'PENDING'],
      ['canceled', 'CANCELLED'],
    ] as const) {
      execFileMock.mockResolvedValueOnce(MR_JSON)
      execFileMock.mockResolvedValueOnce(JSON.stringify({ id: 7, status }))
      const snap = await gitlabProvider.getPrStatus('/repo', 'feat/x')
      expect(snap?.ci.rollup).toBe(rollup)
    }
  })

  it('leaves ci.rollup null when glab ci get fails (snapshot still returned)', async () => {
    execFileMock.mockResolvedValueOnce(MR_JSON)
    execFileMock.mockRejectedValueOnce(new Error('no pipelines for branch'))
    const snap = await gitlabProvider.getPrStatus('/repo', 'feat/x')
    expect(snap).not.toBeNull()
    expect(snap?.ci.rollup).toBeNull()
  })
})

describe('gitlab forge provider — CI jobs', () => {
  it('maps pipeline jobs to ci.checks', async () => {
    execFileMock.mockResolvedValueOnce(MR_JSON)
    execFileMock.mockResolvedValueOnce(
      JSON.stringify({
        id: 7,
        status: 'failed',
        jobs: [
          { name: 'test', status: 'failed', web_url: 'https://gl/jobs/1' },
          { name: 'build', status: 'success', web_url: 'https://gl/jobs/2' },
          { name: 'lint', status: 'canceled', web_url: 'https://gl/jobs/3' },
          { name: 'deploy', status: 'manual', web_url: 'https://gl/jobs/4' },
          { name: 'cache', status: 'skipped', web_url: 'https://gl/jobs/5' },
          { name: 'e2e', status: 'running', web_url: 'https://gl/jobs/6' },
        ],
      }),
    )
    const snap = await gitlabProvider.getPrStatus('/repo', 'feat/x')
    expect(snap?.ci.checks).toEqual([
      { name: 'test', conclusion: 'FAILURE', status: 'COMPLETED', detailsUrl: 'https://gl/jobs/1' },
      { name: 'build', conclusion: 'SUCCESS', status: 'COMPLETED', detailsUrl: 'https://gl/jobs/2' },
      { name: 'lint', conclusion: 'CANCELLED', status: 'COMPLETED', detailsUrl: 'https://gl/jobs/3' },
      { name: 'deploy', conclusion: 'NEUTRAL', status: 'COMPLETED', detailsUrl: 'https://gl/jobs/4' },
      { name: 'cache', conclusion: 'SKIPPED', status: 'COMPLETED', detailsUrl: 'https://gl/jobs/5' },
      { name: 'e2e', conclusion: null, status: 'IN_PROGRESS', detailsUrl: 'https://gl/jobs/6' },
    ])
  })

  it('yields empty ci.checks when the pipeline has no jobs array', async () => {
    execFileMock.mockResolvedValueOnce(MR_JSON)
    execFileMock.mockResolvedValueOnce(JSON.stringify({ id: 7, status: 'success' }))
    const snap = await gitlabProvider.getPrStatus('/repo', 'feat/x')
    expect(snap?.ci).toEqual({ rollup: 'SUCCESS', checks: [] })
  })

  it('falls back to empty name and null detailsUrl for a job missing those fields', async () => {
    execFileMock.mockResolvedValueOnce(MR_JSON)
    execFileMock.mockResolvedValueOnce(JSON.stringify({ id: 7, status: 'success', jobs: [{ status: 'success' }] }))
    const snap = await gitlabProvider.getPrStatus('/repo', 'feat/x')
    expect(snap?.ci.checks).toEqual([{ name: '', conclusion: 'SUCCESS', status: 'COMPLETED', detailsUrl: null }])
  })
})

describe('gitlab forge provider — readyToMerge', () => {
  it('readyToMerge is true for an OPEN MR with a successful pipeline', async () => {
    execFileMock
      .mockResolvedValueOnce(
        JSON.stringify({
          iid: 7,
          title: 'MR',
          web_url: 'https://gl/x/-/merge_requests/7',
          state: 'opened',
          target_branch: 'main',
        }),
      )
      .mockResolvedValueOnce(JSON.stringify({ status: 'success', jobs: [{ name: 'build', status: 'success' }] }))
    const snap = await gitlabProvider.getPrStatus('/repo', 'feat/x')
    expect(snap?.readyToMerge).toBe(true)
  })

  it('readyToMerge is false when the pipeline failed', async () => {
    execFileMock
      .mockResolvedValueOnce(
        JSON.stringify({
          iid: 8,
          title: 'MR',
          web_url: 'https://gl/x/-/merge_requests/8',
          state: 'opened',
          target_branch: 'main',
        }),
      )
      .mockResolvedValueOnce(JSON.stringify({ status: 'failed', jobs: [{ name: 'build', status: 'failed' }] }))
    const snap = await gitlabProvider.getPrStatus('/repo', 'feat/x')
    expect(snap?.readyToMerge).toBe(false)
  })

  it('maps has_conflicts to mergeable CONFLICTING and is not readyToMerge even with no CI', async () => {
    execFileMock
      .mockResolvedValueOnce(
        JSON.stringify({
          iid: 14,
          title: 'Conflicting MR',
          web_url: 'https://gl/x/-/merge_requests/14',
          state: 'opened',
          target_branch: 'main',
          has_conflicts: true,
        }),
      )
      .mockResolvedValueOnce('') // glab ci get — no pipeline
    const snap = await gitlabProvider.getPrStatus('/repo', 'feat/x')
    expect(snap?.mergeable).toBe('CONFLICTING')
    expect(snap?.readyToMerge).toBe(false)
  })

  it('readyToMerge is true when the MR has no pipeline (no CI configured)', async () => {
    execFileMock
      .mockResolvedValueOnce(
        JSON.stringify({
          iid: 9,
          title: 'MR',
          web_url: 'https://gl/x/-/merge_requests/9',
          state: 'opened',
          target_branch: 'main',
        }),
      )
      .mockResolvedValueOnce('')
    const snap = await gitlabProvider.getPrStatus('/repo', 'feat/x')
    expect(snap?.readyToMerge).toBe(true)
  })
})
