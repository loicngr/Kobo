import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, expect, it, vi } from 'vitest'
import type { SessionHandoff, SessionHandoffRequest } from '../../../shared/session-handoff'
import { useSessionHandoffStore } from '../stores/session-handoff'
import { useWebSocketStore } from '../stores/websocket'
import { useWorkspaceStore } from '../stores/workspace'
import { getCurrentSession } from '../utils/current-session'

function handoff(overrides: Partial<SessionHandoff> = {}): SessionHandoff {
  const configuration = {
    engine: 'codex' as const,
    model: 'auto',
    reasoningEffort: 'high',
    agentPermissionMode: 'bypass' as const,
  }
  return {
    id: 'handoff-1',
    workspaceId: 'ws-1',
    sourceSessionId: 'source',
    targetSessionId: null,
    source: configuration,
    target: configuration,
    generateSummary: true,
    state: 'stopping',
    reportPath: null,
    error: null,
    createdAt: '2026-09-17T12:00:00.000Z',
    updatedAt: '2026-09-17T12:00:00.000Z',
    ...overrides,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.restoreAllMocks()
})

it.each(['failed', 'interrupted', 'cancelled'] as const)(
  'restores the source once when a followed transfer becomes %s',
  (state) => {
    const workspace = useWorkspaceStore()
    workspace.selectedWorkspaceId = 'ws-1'
    workspace.selectedSessionId = 'target'
    const fetchSessions = vi.spyOn(workspace, 'fetchSessions').mockResolvedValue()
    const store = useSessionHandoffStore()
    store.apply(handoff({ state: 'starting', targetSessionId: 'target' }))
    store.apply(handoff({ state, targetSessionId: 'target' }))
    store.apply(handoff({ state, targetSessionId: 'target' }))
    expect(fetchSessions).toHaveBeenCalledTimes(1)
    expect(fetchSessions).toHaveBeenCalledWith('ws-1', 'source')
  },
)

it('restores the source when cancelling an interrupted transfer loaded after reload', async () => {
  const workspace = useWorkspaceStore()
  workspace.selectedWorkspaceId = 'ws-1'
  workspace.selectedSessionId = 'target'
  const fetchSessions = vi.spyOn(workspace, 'fetchSessions').mockResolvedValue()
  const store = useSessionHandoffStore()
  store.apply(handoff({ state: 'interrupted', targetSessionId: 'target' }))
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ handoff: handoff({ state: 'cancelled', targetSessionId: 'target' }) })),
  )
  await store.decide('ws-1', 'handoff-1', 'cancel')
  expect(fetchSessions).toHaveBeenCalledWith('ws-1', 'source')
})

it('clears a cancelled first transfer selection and keeps its failed attempt as history after reload', async () => {
  const workspace = useWorkspaceStore()
  workspace.selectedWorkspaceId = 'ws-1'
  workspace.selectSession('target')
  const failed = {
    id: 'target',
    workspaceId: 'ws-1',
    engine: 'codex',
    status: 'error',
    activationOrder: -1,
    startedAt: '2026-09-17T12:00:00.000Z',
    endedAt: '2026-09-17T12:00:01.000Z',
    pid: null,
    engineSessionId: 'native',
    name: null,
  }
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => Promise.resolve(Response.json([failed]))),
  )
  const store = useSessionHandoffStore()
  store.apply(handoff({ state: 'starting', sourceSessionId: null, targetSessionId: 'target' }))
  store.apply(handoff({ state: 'cancelled', sourceSessionId: null, targetSessionId: 'target' }))
  await flushPromises()
  expect(workspace.selectedSessionId).toBeNull()
  expect(workspace.sessions).toEqual([failed])
  expect(getCurrentSession(workspace.sessions)).toBeUndefined()
  // A stale browser preference from before cancellation must not select the failed target on reload.
  localStorage.setItem('kobo:session:ws-1', 'target')
  setActivePinia(createPinia())
  const reloaded = useWorkspaceStore()
  reloaded.selectedWorkspaceId = 'ws-1'
  await reloaded.fetchSessions('ws-1')
  expect(reloaded.selectedSessionId).toBeNull()
  expect(reloaded.sessions).toEqual([failed])
  reloaded.selectSession('target')
  expect(reloaded.selectedSessionId).toBe('target')
  localStorage.removeItem('kobo:session:ws-1')
})

it('starts a handoff without a synthesis and preserves the explicit source and idempotency key', async () => {
  const result = handoff({ generateSummary: false })
  const fetch = vi.fn().mockResolvedValue(Response.json({ handoff: result }, { status: 202 }))
  vi.stubGlobal('fetch', fetch)
  const input: SessionHandoffRequest = {
    requestId: 'request-1',
    sourceSessionId: 'source',
    target: result.target,
    generateSummary: false,
  }
  const store = useSessionHandoffStore()
  await store.start('ws-1', input)
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual(input)
  expect(store.current['ws-1']).toEqual(result)
  expect(store.isBlocking('ws-1')).toBe(true)
})

it('keeps newer websocket progress when an earlier snapshot finishes late', async () => {
  let resolve!: (response: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done
        }),
    ),
  )
  const store = useSessionHandoffStore()
  const request = store.refresh('ws-1')
  const newer = handoff({ state: 'generating', updatedAt: '2026-09-17T12:00:01.000Z' })
  store.apply(newer)
  resolve(Response.json({ handoff: null }))
  await request
  expect(store.current['ws-1']).toEqual(newer)
})

it('does not regress websocket progress when an accepted start response arrives late', async () => {
  let resolve!: (response: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done
        }),
    ),
  )
  const store = useSessionHandoffStore()
  const initial = handoff()
  const request = store.start('ws-1', {
    requestId: 'request-1',
    sourceSessionId: 'source',
    target: initial.target,
    generateSummary: true,
  })
  store.apply(handoff({ state: 'generating' }))
  resolve(Response.json({ handoff: initial }))
  await request
  expect(store.current['ws-1']?.state).toBe('generating')
})

it('accepts a new operation even if an older operation snapshot arrived while starting', async () => {
  let resolve!: (response: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done
        }),
    ),
  )
  const store = useSessionHandoffStore()
  const initial = handoff()
  const request = store.start('ws-1', {
    requestId: 'request-1',
    sourceSessionId: 'source',
    target: initial.target,
    generateSummary: true,
  })
  store.apply(handoff({ id: 'previous', state: 'cancelled', updatedAt: '2026-09-17T11:00:00.000Z' }))
  resolve(Response.json({ handoff: initial }))
  await request
  expect(store.current['ws-1']?.id).toBe('handoff-1')
  expect(store.isBlocking('ws-1')).toBe(true)
})

it('selects the target once on completion without stealing selection from another workspace', async () => {
  const workspaces = useWorkspaceStore()
  workspaces.selectedWorkspaceId = 'ws-1'
  const fetchSessions = vi.spyOn(workspaces, 'fetchSessions').mockResolvedValue()
  const store = useSessionHandoffStore()
  const completed = handoff({ state: 'completed', targetSessionId: 'target' })
  store.apply(handoff({ state: 'starting' }))
  store.apply(completed)
  store.apply(completed)
  expect(fetchSessions).toHaveBeenCalledTimes(1)
  expect(fetchSessions).toHaveBeenCalledWith('ws-1', 'target')
  expect(store.isBlocking('ws-1')).toBe(false)
  workspaces.selectedWorkspaceId = 'elsewhere'
  store.apply(handoff({ id: 'handoff-2', state: 'starting' }))
  store.apply(handoff({ id: 'handoff-2', state: 'completed', targetSessionId: 'other-target' }))
  expect(fetchSessions).toHaveBeenCalledTimes(1)
})

it('preserves a later conversation when loading a historical completed handoff after reload', async () => {
  const workspaces = useWorkspaceStore()
  workspaces.selectedWorkspaceId = 'ws-1'
  workspaces.selectedSessionId = 'later-auto-loop-session'
  const fetchSessions = vi.spyOn(workspaces, 'fetchSessions').mockResolvedValue()
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        handoff: handoff({ state: 'completed', targetSessionId: 'old-target' }),
      }),
    ),
  )
  await useSessionHandoffStore().refresh('ws-1')
  expect(fetchSessions).not.toHaveBeenCalled()
  expect(workspaces.selectedSessionId).toBe('later-auto-loop-session')
})

it('does not force the source when reloading a historical cancellation or viewing another workspace', () => {
  const workspace = useWorkspaceStore()
  workspace.selectedWorkspaceId = 'ws-1'
  workspace.selectedSessionId = 'later-session'
  const fetchSessions = vi.spyOn(workspace, 'fetchSessions').mockResolvedValue()
  const store = useSessionHandoffStore()
  store.apply(handoff({ state: 'cancelled', targetSessionId: 'old-target' }))
  expect(workspace.selectedSessionId).toBe('later-session')
  workspace.selectedWorkspaceId = 'elsewhere'
  store.apply(handoff({ id: 'handoff-2', state: 'starting', targetSessionId: 'target' }))
  store.apply(handoff({ id: 'handoff-2', state: 'cancelled', targetSessionId: 'target' }))
  expect(fetchSessions).not.toHaveBeenCalled()
})

it('selects an explicitly initiated handoff that already completed before the HTTP response', async () => {
  const workspaces = useWorkspaceStore()
  workspaces.selectedWorkspaceId = 'ws-1'
  const fetchSessions = vi.spyOn(workspaces, 'fetchSessions').mockResolvedValue()
  const completed = handoff({ state: 'completed', targetSessionId: 'target' })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ handoff: completed })))
  await useSessionHandoffStore().start('ws-1', {
    requestId: 'request-1',
    sourceSessionId: 'source',
    target: completed.target,
    generateSummary: false,
  })
  expect(fetchSessions).toHaveBeenCalledWith('ws-1', 'target')
})

it('does not follow a background completion later when the user returns to its workspace', () => {
  const workspaces = useWorkspaceStore()
  workspaces.selectedWorkspaceId = 'elsewhere'
  const fetchSessions = vi.spyOn(workspaces, 'fetchSessions').mockResolvedValue()
  const store = useSessionHandoffStore()
  store.apply(handoff({ state: 'starting' }))
  const completed = handoff({ state: 'completed', targetSessionId: 'old-target' })
  store.apply(completed)
  workspaces.selectedWorkspaceId = 'ws-1'
  store.apply(completed)
  expect(fetchSessions).not.toHaveBeenCalled()
})

it.each(['failed', 'interrupted'] as const)('keeps %s handoffs blocked until a decision', (state) => {
  const store = useSessionHandoffStore()
  store.apply(handoff({ state }))
  expect(store.isBlocking('ws-1')).toBe(true)
})

it('makes retry, skip and cancel explicit requests and reports backend failures', async () => {
  const store = useSessionHandoffStore()
  store.apply(handoff({ state: 'failed', error: 'Quota exhausted' }))
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ error: 'Engine still running' }, { status: 409 }))
    .mockResolvedValue(Response.json({ handoff: handoff({ state: 'cancelled' }) }))
  vi.stubGlobal('fetch', fetch)
  await expect(store.decide('ws-1', 'handoff-1', 'skip')).rejects.toThrow('Engine still running')
  expect(store.current['ws-1']?.state).toBe('failed')
  await store.decide('ws-1', 'handoff-1', 'cancel')
  expect(fetch.mock.calls[1]![0]).toBe('/api/workspaces/ws-1/session-handoffs/handoff-1/decision')
  expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ action: 'cancel' })
  expect(store.isBlocking('ws-1')).toBe(false)
})

it('routes ephemeral progress to the handoff store but ignores replayed progress', () => {
  const websocket = useWebSocketStore()
  const store = useSessionHandoffStore()
  websocket._routeMessage({ type: 'workspace:handoff', workspaceId: 'ws-1', payload: { handoff: handoff() } })
  expect(store.current['ws-1']?.state).toBe('stopping')
  websocket._replaying = true
  websocket._routeMessage({
    type: 'workspace:handoff',
    workspaceId: 'ws-1',
    payload: { handoff: handoff({ state: 'cancelled' }) },
  })
  expect(store.current['ws-1']?.state).toBe('stopping')
})
