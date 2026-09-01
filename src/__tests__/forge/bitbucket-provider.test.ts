import { beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.fn()
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => {
    const callback = args[args.length - 1] as (error: unknown, result: { stdout: string }) => void
    execFileMock(args[0], args[1])
      .then((stdout: string) => callback(null, { stdout }))
      .catch((error: unknown) => callback(error, { stdout: '' }))
  },
}))

import { bitbucketProvider } from '../../server/services/forge/bitbucket/provider.js'

describe('Bitbucket Community forge provider', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reports a missing bkt binary', async () => {
    execFileMock.mockRejectedValueOnce(Object.assign(new Error('spawn bkt ENOENT'), { code: 'ENOENT' }))
    expect(await bitbucketProvider.isAvailable('/repo')).toEqual({ available: false, reason: 'cli_missing' })
  })

  it('requires an authenticated bkt host or headless token', async () => {
    execFileMock.mockResolvedValueOnce(JSON.stringify({ hosts: null, contexts: null }))
    expect(await bitbucketProvider.isAvailable('/repo')).toEqual({ available: false, reason: 'not_authenticated' })
  })

  it('creates a pull request through bkt JSON output', async () => {
    execFileMock
      .mockResolvedValueOnce('git@bitbucket.org:team/repo.git')
      .mockResolvedValueOnce(
        JSON.stringify({ contexts: [{ name: 'kobo-team-repo', workspace: 'team', default_repo: 'repo' }] }),
      )
      .mockResolvedValueOnce(JSON.stringify({ id: 42, url: 'https://bitbucket.org/team/repo/pull-requests/42' }))
    await expect(
      bitbucketProvider.createPr('/repo', { base: 'main', head: 'feat/x', title: 'Title', body: 'Body' }),
    ).resolves.toEqual({ number: 42, url: 'https://bitbucket.org/team/repo/pull-requests/42' })
    expect(execFileMock).toHaveBeenCalledWith('bkt', [
      '--context',
      'kobo-team-repo',
      'pr',
      'create',
      '--source',
      'feat/x',
      '--target',
      'main',
      '--title',
      'Title',
      '--description',
      'Body',
      '--workspace',
      'team',
      '--repo',
      'repo',
      '--json',
    ])
  })

  it('creates and uses a repository-scoped context when bkt has none yet', async () => {
    execFileMock
      .mockResolvedValueOnce('git@bitbucket.org:team/repo.git')
      .mockResolvedValueOnce(JSON.stringify({ contexts: null }))
      .mockResolvedValueOnce(JSON.stringify({ hosts: [{ key: 'api.bitbucket.org', kind: 'cloud' }] }))
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(JSON.stringify({ id: 43, url: 'https://bitbucket.org/team/repo/pull-requests/43' }))

    await bitbucketProvider.createPr('/repo', { base: 'main', head: 'feat/x', title: 'Title', body: 'Body' })

    expect(execFileMock).toHaveBeenCalledWith('bkt', [
      'context',
      'create',
      'kobo-team-repo',
      '--host',
      'api.bitbucket.org',
      '--workspace',
      'team',
      '--repo',
      'repo',
    ])
  })

  it('uses bkt headless authentication without a context', async () => {
    const previousToken = process.env.BKT_TOKEN
    process.env.BKT_TOKEN = 'test-token'
    execFileMock
      .mockResolvedValueOnce('git@bitbucket.org:team/repo.git')
      .mockResolvedValueOnce(JSON.stringify({ id: 44, url: 'https://bitbucket.org/team/repo/pull-requests/44' }))

    try {
      await bitbucketProvider.createPr('/repo', { base: 'main', head: 'feat/x', title: 'Title', body: 'Body' })
      expect(execFileMock).toHaveBeenCalledWith('bkt', [
        'pr',
        'create',
        '--source',
        'feat/x',
        '--target',
        'main',
        '--title',
        'Title',
        '--description',
        'Body',
        '--workspace',
        'team',
        '--repo',
        'repo',
        '--json',
      ])
    } finally {
      if (previousToken === undefined) delete process.env.BKT_TOKEN
      else process.env.BKT_TOKEN = previousToken
    }
  })

  it('maps a Cloud pull request and its build checks', async () => {
    execFileMock
      .mockResolvedValueOnce('git@bitbucket.org:team/repo.git')
      .mockResolvedValueOnce(
        JSON.stringify({ contexts: [{ name: 'kobo-team-repo', workspace: 'team', default_repo: 'repo' }] }),
      )
      .mockResolvedValueOnce(JSON.stringify({ pull_requests: [{ id: 7, source: { branch: { name: 'feat/x' } } }] }))
      .mockResolvedValueOnce(
        JSON.stringify({
          pull_request: {
            id: 7,
            title: 'Feature',
            state: 'OPEN',
            updated_on: '2026-08-01T10:00:00Z',
            author: { nickname: 'alice' },
            source: { branch: { name: 'feat/x' } },
            destination: { branch: { name: 'main' } },
            links: { html: { href: 'https://bitbucket.org/team/repo/pull-requests/7' } },
            reviewers: [{ nickname: 'bob' }],
            participants: [{ user: { nickname: 'bob' }, approved: true }],
          },
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          statuses: [{ key: 'build', name: 'Build', state: 'SUCCESSFUL', url: 'https://ci.example/build' }],
        }),
      )

    const snapshot = await bitbucketProvider.getPrStatus('/repo', 'feat/x')

    expect(snapshot).toMatchObject({
      number: 7,
      title: 'Feature',
      base: 'main',
      author: { login: 'alice' },
      ci: { rollup: 'SUCCESS' },
      readyToMerge: true,
    })
    expect(snapshot?.reviewers).toEqual([{ login: 'bob', state: 'APPROVED' }])
  })

  it('keeps the source branch on merge so Kobo can offer remote deletion', async () => {
    execFileMock.mockResolvedValueOnce('git@bitbucket.org:team/repo.git')
    execFileMock.mockResolvedValueOnce(
      JSON.stringify({ contexts: [{ name: 'kobo-team-repo', workspace: 'team', default_repo: 'repo' }] }),
    )
    execFileMock.mockResolvedValueOnce('')
    await bitbucketProvider.mergeRequest('/repo', 7)
    expect(execFileMock).toHaveBeenCalledWith('bkt', [
      '--context',
      'kobo-team-repo',
      'pr',
      'merge',
      '7',
      '--close-source=false',
      '--workspace',
      'team',
      '--repo',
      'repo',
    ])
  })

  it('finds a merged pull request for the post-merge branch cleanup flow', async () => {
    execFileMock
      .mockResolvedValueOnce('https://bitbucket.org/team/repo.git')
      .mockResolvedValueOnce(
        JSON.stringify({ contexts: [{ name: 'kobo-team-repo', workspace: 'team', default_repo: 'repo' }] }),
      )
      .mockResolvedValueOnce(JSON.stringify({ pull_requests: [] }))
      .mockResolvedValueOnce(
        JSON.stringify({ pull_requests: [{ id: 8, source: { branch: { name: 'feat/merged' } } }] }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          pull_request: {
            id: 8,
            title: 'Merged',
            state: 'MERGED',
            source: { branch: { name: 'feat/merged' } },
            destination: { branch: { name: 'main' } },
            links: { html: { href: 'https://bitbucket.org/team/repo/pull-requests/8' } },
          },
        }),
      )
      .mockResolvedValueOnce(JSON.stringify({ statuses: [] }))

    await expect(bitbucketProvider.getPrStatus('/repo', 'feat/merged')).resolves.toMatchObject({ state: 'MERGED' })
  })

  it('declares only bkt capabilities that the CLI exposes', () => {
    expect(bitbucketProvider.capabilities).toEqual({
      canCreatePr: true,
      canChangePrBase: false,
      canMergeRequest: true,
      canDeleteRemoteBranch: true,
      canListPullRequests: true,
      requestTermShort: 'PR',
    })
  })
})
