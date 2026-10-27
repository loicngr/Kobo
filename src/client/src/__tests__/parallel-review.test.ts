import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import ParallelReviewStatusPanel from '../components/ParallelReviewStatusPanel.vue'
import PermissionRequestPanel from '../components/PermissionRequestPanel.vue'
import en from '../i18n/en'
import { useAgentStreamStore } from '../stores/agent-stream'
import { useParallelReviewStore } from '../stores/parallel-review'
import { dispatchAgentEvent, useWebSocketStore } from '../stores/websocket'
import { type AgentSession, useWorkspaceStore, type Workspace } from '../stores/workspace'
import type { AgentEvent } from '../types/agent-event'
import { getCurrentSession } from '../utils/current-session'

vi.mock('src/utils/notifications', () => ({ notify: vi.fn() }))
const review = {
  reviewSessionId: 'review',
  originalSessionId: 'main',
  phase: 'reviewing' as const,
  compacting: false,
  error: null,
  returnToSession: false,
}
const session = (id: string, role: AgentSession['role'] = 'primary'): AgentSession => ({
  id,
  workspaceId: 'w',
  role,
  status: 'running',
  engineSessionId: id,
  engine: 'claude-code',
  startedAt: id === 'main' ? '2026-10-26T00:00:00Z' : '2026-10-27T00:00:00Z',
  endedAt: null,
  pid: null,
  name: null,
})
beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  const ws = useWorkspaceStore()
  ws.workspaces = [{ id: 'w', status: 'executing', autoLoop: true } as Workspace]
  ws.selectedWorkspaceId = 'w'
  ws.selectedSessionId = 'main'
  ws.activeAgentSessionIds.w = 'main'
  vi.spyOn(ws, 'fetchSessions').mockResolvedValue()
  vi.spyOn(ws, 'fetchWorkspaces').mockResolvedValue()
  vi.spyOn(ws, 'fetchWorkspaceDetails').mockResolvedValue()
  vi.spyOn(useParallelReviewStore(), 'fetchStatus').mockResolvedValue()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function dispatch(event: AgentEvent, id = 'review') {
  dispatchAgentEvent(
    'w',
    { ...event, ...(id === 'review' ? { sessionRole: 'parallel-review' as const } : {}) },
    '2026-10-27T12:00:00Z',
    undefined,
    id,
  )
}

it('isolates reviewer lifecycle, compaction, quota and pending inputs before session DTO hydration', () => {
  const ws = useWorkspaceStore()
  const reviews = useParallelReviewStore()
  reviews.setStatus('w', review)
  dispatch({ kind: 'session:started', engineSessionId: 'native' } as AgentEvent)
  dispatch({ kind: 'session:compacting', active: true })
  expect(useWebSocketStore().isCompacting('w', 'review')).toBe(true)
  expect(useWebSocketStore().isCompacting('w')).toBe(false)
  dispatch({
    kind: 'session:user-input-requested',
    toolCallId: 'same',
    toolName: 'Bash',
    requestKind: 'permission',
    payload: {},
  })
  dispatch({ kind: 'error', category: 'quota', message: 'Quota' } as AgentEvent)
  dispatch({
    kind: 'tool:call',
    toolCallId: 'todos',
    name: 'TodoWrite',
    input: { todos: [{ content: 'review' }] },
  } as AgentEvent)
  dispatch({ kind: 'turn:completed' })
  dispatch({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
  expect(ws.workspaces[0]?.status).toBe('executing')
  expect(ws.activeAgentSessionIds.w).toBe('main')
  expect(ws.selectedSessionId).toBe('main')
  expect(ws.settledAgentSessionIds.w).toBeUndefined()
  expect(ws.agentTodos.w).toBeUndefined()
  expect(useAgentStreamStore().eventsFor('w')).toHaveLength(6)
  expect(ws.pendingQueue.w).toBeUndefined()
})

it('keeps overlapping subagent ids separate and does not finalize reviewer cards when primary ends', () => {
  const ws = useWorkspaceStore()
  const progress = { kind: 'subagent:progress', toolCallId: 'same', taskId: 'task', status: 'running' } as AgentEvent
  dispatch(progress, 'main')
  dispatch(progress)
  expect(Object.values(ws.subagents.w!)).toHaveLength(2)
  dispatch({ kind: 'session:ended', reason: 'completed', exitCode: 0 }, 'main')
  expect(Object.values(ws.subagents.w!).find((sub) => sub.sessionId === 'review')?.status).toBe('running')
  expect(Object.values(ws.subagents.w!).find((sub) => sub.sessionId === 'main')?.status).toBe('done')
})

it.each(['snapshot', 'delta'])('replays reviewer events without replacing primary ownership (%s)', (mode) => {
  const ws = useWorkspaceStore()
  ws.updateAgentTodos('w', [{ content: 'Main task', status: 'in_progress' }])
  useWebSocketStore()._routeMessage({
    type: 'sync:response',
    payload: {
      mode,
      events: [
        {
          id: '1',
          workspaceId: 'w',
          type: 'agent:event',
          sessionId: 'review',
          createdAt: '2026-10-27T12:00:00Z',
          payload: { kind: 'session:started', engineSessionId: 'native', sessionRole: 'parallel-review' },
        },
        {
          id: '2',
          workspaceId: 'w',
          type: 'agent:event',
          sessionId: 'review',
          createdAt: '2026-10-27T12:00:01Z',
          payload: {
            kind: 'tool:call',
            name: 'TodoWrite',
            toolCallId: 'todo',
            input: { todos: [{ content: 'review' }] },
            sessionRole: 'parallel-review',
          },
        },
        {
          id: '3',
          workspaceId: 'w',
          type: 'agent:event',
          sessionId: 'review',
          createdAt: '2026-10-27T12:00:02Z',
          payload: {
            kind: 'session:user-input-requested',
            toolCallId: 'question',
            toolName: 'AskUserQuestion',
            requestKind: 'question',
            payload: {},
            sessionRole: 'parallel-review',
          },
        },
      ],
    },
  })
  expect(ws.activeAgentSessionIds.w).toBe('main')
  expect(ws.selectedSessionId).toBe('main')
  expect(ws.currentAgentTodos).toEqual([{ content: 'Main task', status: 'in_progress' }])
  expect(ws.peekPending('w')).toBeUndefined()
  expect(ws.peekPending('w', 'review')?.toolCallId).toBe('question')
})

it('selects primary implicitly but retains explicit reviewer selection', async () => {
  const ws = useWorkspaceStore()
  vi.mocked(ws.fetchSessions).mockRestore()
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(Response.json([session('review', 'parallel-review'), session('main')])),
      ),
  )
  ws.selectedSessionId = null
  await ws.fetchSessions('w')
  expect(ws.selectedSessionId).toBe('main')
  expect(getCurrentSession(ws.sessions)?.id).toBe('main')
  await ws.fetchSessions('w', 'review')
  expect(ws.selectedSessionId).toBe('review')
})

it('targets matching permission identity across a delayed response and a FIFO change', async () => {
  const ws = useWorkspaceStore()
  useParallelReviewStore().remember('w', 'review')
  for (const agentSessionId of ['main', 'review'])
    ws.enqueuePending('w', { kind: 'permission', agentSessionId, toolCallId: 'same', toolName: 'Bash', toolInput: {} })
  let resolve!: (response: Response) => void
  const fetch = vi.fn(
    (_url: string, _options?: RequestInit) =>
      new Promise<Response>((done) => {
        resolve = done
      }),
  )
  vi.stubGlobal('fetch', fetch)
  const pending = ws.submitDeferredPermission('w', 'same', 'allow', undefined, 'once', 'review')
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject({
    sessionId: 'review',
    toolCallId: 'same',
    scope: 'once',
  })
  ws.enqueuePending('w', {
    kind: 'question',
    agentSessionId: 'review',
    toolCallId: 'next',
    toolName: 'AskUserQuestion',
    input: {},
  })
  resolve(Response.json({ ok: true }))
  await pending
  expect(ws.pendingQueue.w?.map((item) => [item.agentSessionId, item.toolCallId])).toEqual([
    ['main', 'same'],
    ['review', 'next'],
  ])
})

it('guards status hydration against newer events and sends exact ids for every action', async () => {
  const reviews = useParallelReviewStore()
  vi.mocked(reviews.fetchStatus).mockRestore()
  let resolve!: (response: Response) => void
  const fetch = vi.fn(
    (_url: string, _options?: RequestInit) =>
      new Promise<Response>((done) => {
        resolve = done
      }),
  )
  vi.stubGlobal('fetch', fetch)
  const pending = reviews.fetchStatus('w')
  reviews.setStatus('w', { ...review, reviewSessionId: 'new' })
  resolve(Response.json(review))
  await pending
  expect(reviews.statuses.w?.reviewSessionId).toBe('new')
  vi.spyOn(reviews, 'fetchStatus').mockResolvedValue()
  fetch.mockImplementation(async () => Response.json({ ok: true }))
  for (const action of ['stop', 'retry-return', 'cancel-return'] as const) {
    await reviews.act('w', 'review', action)
    expect(fetch).toHaveBeenLastCalledWith(
      `/api/workspaces/w/parallel-review/${action}`,
      expect.objectContaining({ body: JSON.stringify({ sessionId: 'review' }) }),
    )
  }
})

it('returns to the exact source only from the matching review view with return enabled', () => {
  const ws = useWorkspaceStore()
  const socket = useWebSocketStore()
  for (const [workspaceId, selected, enabled, expected] of [
    ['w', 'review', false, 'review'],
    ['other', 'review', true, 'review'],
    ['w', 'other-session', true, 'other-session'],
    ['w', 'review', true, 'main'],
  ] as const) {
    ws.selectedWorkspaceId = workspaceId
    ws.selectedSessionId = selected
    useParallelReviewStore().setStatus('w', { ...review, returnToSession: enabled })
    socket._routeMessage({
      type: 'review:parallel-status',
      workspaceId: 'w',
      payload: { ...review, phase: 'completed', returnToSession: enabled },
    })
    expect(ws.selectedSessionId).toBe(expected)
  }
})

function panel(component: typeof ParallelReviewStatusPanel | typeof PermissionRequestPanel) {
  return mount(component, {
    props: { workspaceId: 'w' },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
      stubs: {
        QBtn: { props: ['label', 'disable'], template: '<button :disabled="disable">{{ label }}</button>' },
        QIcon: true,
        QSpace: true,
        QTooltip: true,
      },
    },
  })
}
it('offers only one-shot reviewer permissions and no principal requests in the reviewer view', async () => {
  const ws = useWorkspaceStore()
  useParallelReviewStore().remember('w', 'review')
  ws.selectedSessionId = 'review'
  ws.enqueuePending('w', {
    kind: 'permission',
    agentSessionId: 'main',
    toolCallId: 'same',
    toolName: 'Write',
    toolInput: {},
  })
  const view = panel(PermissionRequestPanel)
  expect(view.find('button').exists()).toBe(false)
  ws.enqueuePending('w', {
    kind: 'permission',
    agentSessionId: 'review',
    toolCallId: 'same',
    toolName: 'Bash',
    toolInput: {},
  })
  await flushPromises()
  expect(view.text()).toContain('Bash')
  expect(view.text()).not.toContain(en['permissionRequest.allowTurn'])
  expect(view.text()).not.toContain(en['permissionRequest.allowTool'])
  view.unmount()
})
it('shows durable uncertainty, requires explicit actions and discards late action errors after reviewer replacement', async () => {
  const reviews = useParallelReviewStore()
  reviews.setStatus('w', { ...review, phase: 'unknown', returnToSession: true })
  let reject!: (error: Error) => void
  const act = vi.spyOn(reviews, 'act').mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail
      }),
  )
  const view = panel(ParallelReviewStatusPanel)
  expect(view.text()).toContain('Delivery uncertain')
  expect(act).not.toHaveBeenCalled()
  await view.findAll('button')[1]!.trigger('click')
  expect(act).toHaveBeenCalledWith('w', 'review', 'retry-return')
  reviews.setStatus('w', { ...review, reviewSessionId: 'new' })
  await flushPromises()
  reject(new Error('Late failure'))
  await flushPromises()
  expect(view.text()).not.toContain('Late failure')
  view.unmount()
})

it('keeps a later explicit selection while a forced session refresh is in flight', async () => {
  const ws = useWorkspaceStore()
  vi.mocked(ws.fetchSessions).mockRestore()
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
  const pending = ws.fetchSessions('w', 'review')
  ws.selectedSessionId = 'other'
  resolve(Response.json([session('review', 'parallel-review'), session('main'), session('other')]))
  await pending
  expect(ws.selectedSessionId).toBe('other')
})

it('never transfers a reviewer local queue to the primary auto-loop', async () => {
  const ws = useWorkspaceStore()
  useParallelReviewStore().remember('w', 'review')
  ws.queuedMessages['w:review'] = { content: 'Review only', sessionId: 'review' }
  const transfer = vi.spyOn(ws, 'queueAutoLoopMessage').mockResolvedValue({} as never)
  const send = vi.spyOn(useWebSocketStore(), 'sendChatMessage')
  await ws.flushQueuedMessage('w', 'review')
  expect(transfer).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
  expect(ws.queuedMessages['w:review']?.content).toBe('Review only')
})

it.each(['completed', 'interrupted'] as const)(
  'dismisses a %s review locally, survives reload and shows the next review',
  async (phase) => {
    const reviews = useParallelReviewStore()
    const terminalReview = { ...review, phase }
    reviews.setStatus('w', terminalReview)
    const act = vi.spyOn(reviews, 'act')
    const view = panel(ParallelReviewStatusPanel)
    const close = view.get('[data-test="parallel-review-close"]')
    expect(close.text()).toBe(en['common.close'])
    await close.trigger('click')
    expect(view.find('section').exists()).toBe(false)
    expect(reviews.statuses.w).toEqual(terminalReview)
    expect(act).not.toHaveBeenCalled()
    expect(localStorage.getItem('kobo:dismissed-parallel-review:w')).toBe('review')
    view.unmount()

    setActivePinia(createPinia())
    const reloaded = useParallelReviewStore()
    vi.spyOn(reloaded, 'fetchStatus').mockResolvedValue()
    reloaded.setStatus('w', terminalReview)
    const nextView = panel(ParallelReviewStatusPanel)
    expect(nextView.find('section').exists()).toBe(false)
    reloaded.setStatus('w', { ...terminalReview, reviewSessionId: 'new-review' })
    await flushPromises()
    expect(nextView.find('section').exists()).toBe(true)
    nextView.unmount()
  },
)

it('keeps dismissal scoped to the workspace and does not hide actionable phases', async () => {
  const reviews = useParallelReviewStore()
  reviews.setStatus('w', { ...review, phase: 'completed' })
  const view = panel(ParallelReviewStatusPanel)
  await view.get('[data-test="parallel-review-close"]').trigger('click')
  reviews.setStatus('other', { ...review, phase: 'interrupted' })
  await view.setProps({ workspaceId: 'other' })
  expect(view.find('section').exists()).toBe(true)
  await view.setProps({ workspaceId: 'w' })
  expect(view.find('section').exists()).toBe(false)
  for (const phase of ['reviewing', 'ready', 'dispatching', 'blocked', 'unknown'] as const) {
    reviews.setStatus('w', { ...review, phase })
    await flushPromises()
    expect(view.find('section').exists()).toBe(true)
    expect(view.find('[data-test="parallel-review-close"]').exists()).toBe(false)
  }
  view.unmount()
})

it('omits only the redundant interrupted message and preserves informative errors', async () => {
  const reviews = useParallelReviewStore()
  reviews.setStatus('w', { ...review, phase: 'interrupted', error: 'Review did not complete' })
  const view = panel(ParallelReviewStatusPanel)
  expect(view.text()).toContain(en['parallelReview.interrupted'])
  expect(view.text()).not.toContain('Review did not complete')
  reviews.setStatus('w', { ...review, phase: 'interrupted', error: 'Provider quota exceeded' })
  await flushPromises()
  expect(view.text()).toContain('Provider quota exceeded')
  view.unmount()
})

it('still closes a terminal review if browser storage is unavailable', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('Storage disabled')
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Storage disabled')
  })
  useParallelReviewStore().setStatus('w', { ...review, phase: 'interrupted' })
  const view = panel(ParallelReviewStatusPanel)
  await view.get('[data-test="parallel-review-close"]').trigger('click')
  expect(view.find('section').exists()).toBe(false)
  view.unmount()
})

it.each([
  { kind: 'session:started', engineSessionId: 'native-review' },
  { kind: 'session:ended', reason: 'completed', exitCode: 0 },
] satisfies AgentEvent[])(
  'preserves an explicit selection request across reviewer $kind without overriding human navigation',
  async (event) => {
    const ws = useWorkspaceStore()
    vi.mocked(ws.fetchSessions).mockRestore()
    for (const navigate of [false, true]) {
      ws.selectedSessionId = 'main'
      let resolve!: (response: Response) => void
      const fetch = vi.fn(
        (_url: string, options?: RequestInit) =>
          new Promise<Response>((done, reject) => {
            resolve = done
            options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
          }),
      )
      vi.stubGlobal('fetch', fetch)
      const pending = ws.fetchSessions('w', 'review')
      dispatch(event)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(false)
      if (navigate) ws.selectSession('other')
      resolve(Response.json([session('review', 'parallel-review'), session('main'), session('other')]))
      await pending
      expect(ws.selectedSessionId).toBe(navigate ? 'other' : 'review')
    }
  },
)

it('keeps the saved closing review stoppable without offering return actions or dismissal', async () => {
  const reviews = useParallelReviewStore()
  reviews.setStatus('w', { ...review, phase: 'closing', returnToSession: true })
  const act = vi.spyOn(reviews, 'act').mockResolvedValue()
  const view = panel(ParallelReviewStatusPanel)
  expect(view.text()).toContain(en['parallelReview.closing'])
  expect(view.text()).not.toContain(en['reviewReturn.retry'])
  expect(view.text()).not.toContain(en['reviewReturn.cancel'])
  expect(view.find('[data-test="parallel-review-close"]').exists()).toBe(false)
  const stop = view.findAll('button').find((button) => button.text() === en['parallelReview.stop'])!
  expect(stop).toBeDefined()
  await stop.trigger('click')
  expect(act).toHaveBeenCalledWith('w', 'review', 'stop')
  view.unmount()
})
