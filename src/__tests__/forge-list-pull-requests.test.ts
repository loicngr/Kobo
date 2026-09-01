import { describe, expect, it } from 'vitest'
import { mapBitbucketPage } from '../server/services/forge/bitbucket/provider.js'
import { buildGithubSearchQuery, mapGithubSearchPage } from '../server/services/forge/github/provider.js'
import { buildGitlabListArgs, mapGitlabPage } from '../server/services/forge/gitlab/provider.js'
import { noneProvider } from '../server/services/forge/none.js'

describe('noneProvider.listPullRequests', () => {
  it('returns an empty page and declares the capability off', async () => {
    expect(noneProvider.capabilities.canListPullRequests).toBe(false)
    const page = await noneProvider.listPullRequests('/tmp/repo', {
      filter: 'all',
      perPage: 25,
    })
    expect(page).toEqual({ items: [], nextCursor: null })
  })
})

describe('buildGithubSearchQuery', () => {
  it('scopes to the repo and to open PRs, newest first', () => {
    expect(buildGithubSearchQuery('acme/app', { filter: 'all', perPage: 25 })).toBe(
      'repo:acme/app is:pr is:open sort:updated-desc',
    )
  })

  it('adds the author filter', () => {
    expect(buildGithubSearchQuery('acme/app', { filter: 'mine', perPage: 25 })).toContain('author:@me')
  })

  it('adds the review-requested filter', () => {
    expect(buildGithubSearchQuery('acme/app', { filter: 'review-requested', perPage: 25 })).toContain(
      'review-requested:@me',
    )
  })

  it('appends the free-text search', () => {
    expect(buildGithubSearchQuery('acme/app', { filter: 'all', perPage: 25, search: 'login bug' })).toContain(
      'login bug',
    )
  })
})

describe('mapGithubSearchPage', () => {
  const raw = {
    data: {
      search: {
        pageInfo: { hasNextPage: true, endCursor: 'CURSOR1' },
        nodes: [
          {
            number: 42,
            title: 'Fix login',
            url: 'https://github.com/acme/app/pull/42',
            isDraft: false,
            updatedAt: '2026-08-30T10:00:00Z',
            author: { login: 'alice' },
            headRefName: 'fix/login',
            baseRefName: 'develop',
            isCrossRepository: false,
            reviewDecision: 'APPROVED',
            commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
          },
        ],
      },
    },
  }

  it('maps a node to a PullRequestSummary', () => {
    const page = mapGithubSearchPage(raw)
    expect(page.nextCursor).toBe('CURSOR1')
    expect(page.items[0]).toEqual({
      number: 42,
      title: 'Fix login',
      url: 'https://github.com/acme/app/pull/42',
      author: 'alice',
      headBranch: 'fix/login',
      baseBranch: 'develop',
      isFork: false,
      isDraft: false,
      updatedAt: '2026-08-30T10:00:00Z',
      ci: 'SUCCESS',
      reviewDecision: 'APPROVED',
    })
  })

  it('returns a null cursor on the last page', () => {
    const last = { data: { search: { pageInfo: { hasNextPage: false, endCursor: 'X' }, nodes: [] } } }
    expect(mapGithubSearchPage(last).nextCursor).toBeNull()
  })

  it('marks a cross-repository PR as a fork', () => {
    const fork = structuredClone(raw)
    fork.data.search.nodes[0].isCrossRepository = true
    expect(mapGithubSearchPage(fork).items[0].isFork).toBe(true)
  })

  it('reports a missing rollup as null rather than throwing', () => {
    const noCi = structuredClone(raw)
    noCi.data.search.nodes[0].commits.nodes = []
    expect(mapGithubSearchPage(noCi).items[0].ci).toBeNull()
  })
})

describe('buildGitlabListArgs', () => {
  it('requests page 1 by default', () => {
    expect(buildGitlabListArgs({ filter: 'all', perPage: 25 })).toEqual([
      'mr',
      'list',
      '--output',
      'json',
      '--per-page',
      '25',
      '--page',
      '1',
    ])
  })

  it('resumes from the cursor', () => {
    expect(buildGitlabListArgs({ filter: 'all', perPage: 25, cursor: '3' })).toEqual([
      'mr',
      'list',
      '--output',
      'json',
      '--per-page',
      '25',
      '--page',
      '3',
    ])
  })

  it('adds the author filter', () => {
    expect(buildGitlabListArgs({ filter: 'mine', perPage: 25 })).toContain('--author=@me')
  })

  it('adds the reviewer filter', () => {
    expect(buildGitlabListArgs({ filter: 'review-requested', perPage: 25 })).toContain('--reviewer=@me')
  })

  it('appends the free-text search', () => {
    expect(buildGitlabListArgs({ filter: 'all', perPage: 25, search: 'login bug' })).toContain('--search')
    expect(buildGitlabListArgs({ filter: 'all', perPage: 25, search: 'login bug' })).toContain('login bug')
  })
})

describe('mapGitlabPage', () => {
  const raw = [
    {
      iid: 7,
      title: 'Add cache',
      web_url: 'https://gitlab.com/acme/app/-/merge_requests/7',
      draft: false,
      updated_at: '2026-08-29T09:00:00Z',
      author: { username: 'bob' },
      source_branch: 'feat/cache',
      target_branch: 'main',
      source_project_id: 10,
      target_project_id: 10,
    },
  ]

  it('maps an MR and advances the cursor when the page is full', () => {
    const page = mapGitlabPage(raw, { filter: 'all', perPage: 1, cursor: '1' })
    expect(page.items[0]).toMatchObject({
      number: 7,
      title: 'Add cache',
      author: 'bob',
      headBranch: 'feat/cache',
      baseBranch: 'main',
      isFork: false,
      isDraft: false,
    })
    expect(page.nextCursor).toBe('2')
  })

  it('stops when the page is not full', () => {
    expect(mapGitlabPage(raw, { filter: 'all', perPage: 25 }).nextCursor).toBeNull()
  })

  it('flags a fork when the source project differs from the target', () => {
    const fork = structuredClone(raw)
    fork[0].source_project_id = 99
    expect(mapGitlabPage(fork, { filter: 'all', perPage: 25 }).items[0].isFork).toBe(true)
  })
})

describe('mapBitbucketPage', () => {
  it('maps a Cloud payload and extracts the page number as the cursor', () => {
    const page = mapBitbucketPage({
      values: [
        {
          id: 5,
          title: 'Tidy logs',
          links: { html: { href: 'https://bitbucket.org/acme/app/pull-requests/5' } },
          author: { nickname: 'carol' },
          source: { branch: { name: 'chore/logs' }, repository: { uuid: 'A' } },
          destination: { branch: { name: 'main' }, repository: { uuid: 'A' } },
          updated_on: '2026-08-28T08:00:00Z',
        },
      ],
      next: 'https://api.bitbucket.org/2.0/…?page=2',
    })
    expect(page.items[0]).toMatchObject({
      number: 5,
      title: 'Tidy logs',
      author: 'carol',
      headBranch: 'chore/logs',
      baseBranch: 'main',
      isFork: false,
    })
    expect(page.nextCursor).toBe('2')
  })

  it('maps a Data Center payload and stops on the last page', () => {
    const page = mapBitbucketPage({
      values: [
        {
          id: 9,
          title: 'DC change',
          fromRef: { displayId: 'feat/dc', repository: { id: 1 } },
          toRef: { displayId: 'develop', repository: { id: 1 } },
          author: { user: { name: 'dan' } },
          updatedDate: 1756368000000,
        },
      ],
      isLastPage: true,
    })
    expect(page.items[0].headBranch).toBe('feat/dc')
    expect(page.nextCursor).toBeNull()
  })

  it('flags a fork when the source repository differs', () => {
    const page = mapBitbucketPage({
      values: [
        {
          id: 6,
          title: 'From a fork',
          source: { branch: { name: 'x' }, repository: { uuid: 'B' } },
          destination: { branch: { name: 'main' }, repository: { uuid: 'A' } },
        },
      ],
    })
    expect(page.items[0].isFork).toBe(true)
  })

  it('does not flag a fork when neither side carries repository id info', () => {
    const page = mapBitbucketPage({
      values: [
        {
          id: 7,
          title: 'No repo info',
          source: { branch: { name: 'x' } },
          destination: { branch: { name: 'main' } },
        },
      ],
    })
    expect(page.items[0].isFork).toBe(false)
  })
})
