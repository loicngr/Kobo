import { describe, expect, it } from 'vitest'
import type { AgentLiveness, PrSnapshot, Workspace } from '../stores/workspace'
import { parseWorkspaceSort, sortWorkspaces, workspaceActivityAt } from '../utils/workspace-sort'

const ws = (id: string, fields: Partial<Workspace> = {}): Workspace =>
  ({
    id,
    name: id,
    status: 'idle',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...fields,
  }) as Workspace
const ids = (items: Workspace[]) => items.map((item) => item.id)

describe('workspace sorting', () => {
  it('uses live agent activity without changing the input order', () => {
    const items = [ws('older'), ws('newer', { updatedAt: '2026-02-01T00:00:00Z' })]
    const liveness = { older: { lastEventAt: '2026-03-01T00:00:00Z' } as AgentLiveness }
    expect(ids(sortWorkspaces(items, { field: 'activity', direction: 'desc' }, { liveness }))).toEqual([
      'older',
      'newer',
    ])
    expect(ids(items)).toEqual(['older', 'newer'])
    expect(ids(sortWorkspaces(items, { field: 'activity', direction: 'desc' }))).toEqual(['newer', 'older'])
  })
  it('does not use unread markers or favorites as activity', () => {
    const original = ws('one')
    expect(workspaceActivityAt({ ...original, hasUnread: false, favoritedAt: '2026-04-01T00:00:00Z' })).toBe(
      workspaceActivityAt(original),
    )
  })
  it('sorts creation independently from updates and reverses direction', () => {
    const items = [ws('old', { updatedAt: '2026-05-01T00:00:00Z' }), ws('new', { createdAt: '2026-02-01T00:00:00Z' })]
    expect(ids(sortWorkspaces(items, { field: 'created', direction: 'desc' }))).toEqual(['new', 'old'])
    expect(ids(sortWorkspaces(items, { field: 'created', direction: 'asc' }))).toEqual(['old', 'new'])
  })
  it('uses locale aware numeric names', () => {
    const items = [ws('ten', { name: 'Mission 10' }), ws('two', { name: 'mission 2' })]
    expect(ids(sortWorkspaces(items, { field: 'name', direction: 'asc' }, { locale: 'fr' }))).toEqual(['two', 'ten'])
  })
  it('prioritizes questions, failures, review, quotas and ready PRs', () => {
    const items = [
      ws('idle'),
      ws('ready'),
      ws('quota', { status: 'quota' }),
      ws('error', { status: 'error' }),
      ws('question', { status: 'awaiting-user' }),
    ]
    const snapshots = {
      ready: { readyToMerge: true, ci: { rollup: null, checks: [] }, state: 'OPEN' } as unknown as PrSnapshot,
    }
    expect(ids(sortWorkspaces(items, { field: 'attention', direction: 'desc' }, { snapshots }))).toEqual([
      'question',
      'error',
      'quota',
      'ready',
      'idle',
    ])
  })
  it('ranks genuine quotas before transient retries', () => {
    const items = [ws('a-retry', { status: 'quota' }), ws('z-quota', { status: 'quota' })]
    const context = { quotaBackoffReasons: { 'a-retry': 'transient', 'z-quota': 'quota' } as const }
    expect(ids(sortWorkspaces(items, { field: 'attention', direction: 'desc' }, context))).toEqual([
      'z-quota',
      'a-retry',
    ])
    expect(ids(sortWorkspaces(items, { field: 'attention', direction: 'asc' }, context))).toEqual([
      'a-retry',
      'z-quota',
    ])
  })
  it('resolves ties consistently and handles invalid dates in archived records', () => {
    const items = [ws('b', { createdAt: 'invalid', updatedAt: '' }), ws('a', { createdAt: '', updatedAt: '' })]
    expect(ids(sortWorkspaces(items, { field: 'activity', direction: 'desc' }))).toEqual(['a', 'b'])
    expect(sortWorkspaces([], { field: 'name', direction: 'desc' })).toEqual([])
  })
  it.each([
    null,
    '{broken',
    '{}',
    'null',
    '{"field":"unknown","direction":"asc"}',
    '{"field":"name","direction":"sideways"}',
  ])('recovers invalid stored preferences %s', (raw) => {
    expect(parseWorkspaceSort(raw)).toEqual({ field: 'activity', direction: 'desc' })
  })
  it('keeps an exact search match ahead of a newer fuzzy match and sorts equal matches by preference', () => {
    const fields = {
      workingBranch: '',
      sourceBranch: '',
      projectPath: '/project',
      description: null,
      agentDescription: null,
      tags: [],
    }
    const items = [
      ws('fuzzy', { ...fields, name: 'repair login flow', updatedAt: '2026-09-01T00:00:00Z' }),
      ws('exact-old', { ...fields, name: 'login' }),
      ws('exact-new', { ...fields, name: 'login', updatedAt: '2026-08-01T00:00:00Z' }),
    ]
    expect(ids(sortWorkspaces(items, { field: 'activity', direction: 'desc' }, { query: 'login' }))).toEqual([
      'exact-new',
      'exact-old',
      'fuzzy',
    ])
  })
  it('restores both saved preferences', () => {
    expect(parseWorkspaceSort('{"field":"name","direction":"asc"}')).toEqual({ field: 'name', direction: 'asc' })
  })
})
