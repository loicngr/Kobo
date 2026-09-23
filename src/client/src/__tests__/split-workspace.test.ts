import { describe, expect, it } from 'vitest'
import { embeddedWorkspaceUrl, normalizeSplitRatio, splitWorkspaceQuery } from '../utils/split-workspace'

describe('split workspace navigation', () => {
  it('encodes workspace ids in a local embedded URL without tokens', () => {
    expect(embeddedWorkspaceUrl('a/b?#', '/kobo/')).toBe('/kobo/?pane=1#/workspace/a%2Fb%3F%23')
  })
  it('preserves the selected workspace and opens the target on the right', () => {
    expect(splitWorkspaceQuery('first', 'second')).toEqual({ left: 'first', right: 'second' })
    expect(splitWorkspaceQuery('first', 'first')).toEqual({ left: 'first' })
    expect(splitWorkspaceQuery(null, 'second')).toEqual({ left: 'second' })
  })
  it('bounds and validates persisted divider positions', () => {
    expect(normalizeSplitRatio('NaN')).toBe(50)
    expect(normalizeSplitRatio('90')).toBe(75)
    expect(normalizeSplitRatio('10')).toBe(25)
    expect(normalizeSplitRatio('42')).toBe(42)
  })
})

describe('passive split URL synchronization', () => {
  it('preserves reloadable pane selections without bypassing ordinary departures', async () => {
    const { createRouter, createMemoryHistory } = await import('vue-router')
    const { syncSplitLocation, isPassiveSplitNavigation } = await import('../utils/split-workspace')
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/split', name: 'split', component: {} },
        { path: '/elsewhere', name: 'elsewhere', component: {} },
      ],
    })
    await router.push({ name: 'split', query: { left: 'a' } })
    router.beforeEach((to, from) => isPassiveSplitNavigation(to, from))
    await syncSplitLocation(router, { left: 'a', right: 'b' })
    expect(router.currentRoute.value.query).toEqual({ left: 'a', right: 'b' })
    await router.push({ name: 'elsewhere' })
    expect(router.currentRoute.value.name).toBe('split')
    await router.push({ name: 'split', query: { left: 'c' } })
    expect(router.currentRoute.value.query.left).toBe('a')
  })
})

describe('pane destruction', () => {
  it('protects queues belonging to a previously visited workspace', async () => {
    const { hasPanePendingWork } = await import('../utils/split-workspace')
    expect(hasPanePendingWork(false, {})).toBe(false)
    expect(hasPanePendingWork(true, {})).toBe(true)
    expect(hasPanePendingWork(false, { 'old-workspace:session': { content: 'later', sessionId: 'session' } })).toBe(
      true,
    )
  })
})
