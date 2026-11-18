import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('quasar', () => ({ Notify: { create: vi.fn() } }))
vi.mock('src/utils/notifications', () => ({ notify: vi.fn() }))

import { Notify } from 'quasar'
import { notify } from 'src/utils/notifications'
import { toastAllowed, useWebSocketStore } from '../stores/websocket'
import { useWorkspaceStore, type Workspace } from '../stores/workspace'

const OFF = { muteBrowser: false, muteSound: false, muteToast: false, muteDrawer: false, keepQuestions: false }

function seed(prefs: Partial<typeof OFF>) {
  useWorkspaceStore().workspaces = [
    { id: 'w1', name: 'W', notificationPrefs: { ...OFF, ...prefs } } as unknown as Workspace,
  ]
}

const TOASTS = [
  ['pr:base-changed', { oldBase: 'a', newBase: 'b' }],
  ['pr:ci-failed', { prNumber: 1 }],
  ['pr:ci-recovered', { prNumber: 1 }],
  ['pr:merge-conflict', { prNumber: 1 }],
  ['pr:merged', { prNumber: 1 }],
  ['pr:changes-requested', { prNumber: 1 }],
  ['pr:approved', { prNumber: 1 }],
  ['pr:ready-to-merge', { prNumber: 1 }],
  ['autoloop:waiting-for-slot', { running: 1, limit: 1 }],
] as const

describe('websocket toasts and per-workspace notification prefs', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.spyOn(useWorkspaceStore(), 'refreshPrSnapshot').mockResolvedValue(undefined as never)
    vi.spyOn(useWorkspaceStore(), 'fetchAutoLoopStates').mockResolvedValue(undefined as never)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  })

  it.each(TOASTS)('%s toast is suppressed with muteToast', (type, payload) => {
    seed({ muteToast: true })
    useWebSocketStore()._routeMessage({ type, workspaceId: 'w1', payload })
    expect(Notify.create).not.toHaveBeenCalled()
  })

  it.each(TOASTS)('%s toast is shown by default', (type, payload) => {
    seed({})
    useWebSocketStore()._routeMessage({ type, workspaceId: 'w1', payload })
    expect(Notify.create).toHaveBeenCalledOnce()
  })

  it('keepQuestions does not restore non-question toasts', () => {
    seed({ muteToast: true, keepQuestions: true })
    useWebSocketStore()._routeMessage({ type: 'pr:merged', workspaceId: 'w1', payload: { prNumber: 1 } })
    expect(Notify.create).not.toHaveBeenCalled()
  })

  it('the awaiting-reminder toast is suppressed with muteToast alone', () => {
    seed({ muteToast: true })
    useWebSocketStore()._routeMessage({
      type: 'workspace:awaiting-reminder',
      payload: { workspaceId: 'w1', workspaceName: 'W', waitingMinutes: 5 },
    })
    expect(Notify.create).not.toHaveBeenCalled()
  })

  it('the awaiting-reminder toast is shown with keepQuestions, and notify is flagged as a question', () => {
    seed({ muteToast: true, keepQuestions: true })
    useWebSocketStore()._routeMessage({
      type: 'workspace:awaiting-reminder',
      payload: { workspaceId: 'w1', workspaceName: 'W', waitingMinutes: 5 },
    })
    expect(Notify.create).toHaveBeenCalledOnce()
    expect(notify).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      'w1',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      undefined,
      { question: true },
    )
  })

  it('autoloop:disabled flags awaiting-clarification as a question and others not', () => {
    seed({})
    const ws = useWebSocketStore()
    ws._routeMessage({ type: 'autoloop:disabled', workspaceId: 'w1', payload: { reason: 'awaiting-clarification' } })
    expect(vi.mocked(notify).mock.calls.at(-1)?.[7]).toEqual({ question: true })
    ws._routeMessage({ type: 'autoloop:disabled', workspaceId: 'w1', payload: { reason: 'completed' } })
    expect(vi.mocked(notify).mock.calls.at(-1)?.[7]).toBeUndefined()
  })

  it('chat:rejected is always shown', () => {
    seed({ muteToast: true, keepQuestions: false })
    useWebSocketStore()._routeMessage({
      type: 'chat:rejected',
      workspaceId: 'w1',
      payload: { sessionId: 's1', content: 'hi', message: 'nope' },
    })
    expect(Notify.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'negative' }))
  })

  it('toastAllowed is true for an unknown workspace', () => {
    expect(toastAllowed('nope')).toBe(true)
    expect(toastAllowed('nope', true)).toBe(true)
  })

  it('toastAllowed follows muteToast and keepQuestions', () => {
    seed({ muteToast: true })
    expect(toastAllowed('w1')).toBe(false)
    expect(toastAllowed('w1', true)).toBe(false)
    seed({ muteToast: true, keepQuestions: true })
    expect(toastAllowed('w1')).toBe(false)
    expect(toastAllowed('w1', true)).toBe(true)
  })

  it('the permission-request variant also passes the question flag', async () => {
    seed({})
    const { dispatchAgentEvent } = await import('../stores/websocket')
    dispatchAgentEvent(
      'w1',
      {
        kind: 'session:user-input-requested',
        requestKind: 'permission',
        toolCallId: 'p1',
        toolName: 'Bash',
        payload: {},
      },
      undefined,
      undefined,
      's1',
    )
    expect(vi.mocked(notify).mock.calls.at(-1)?.[7]).toEqual({ question: true })
  })
})
