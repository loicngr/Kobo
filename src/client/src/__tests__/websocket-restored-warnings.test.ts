import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pane = vi.hoisted(() => ({ value: false }))

vi.mock('quasar', () => ({ Notify: { create: vi.fn() } }))
vi.mock('src/utils/notifications', () => ({ notify: vi.fn() }))
vi.mock('src/utils/split-workspace', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('src/utils/split-workspace')
  return new Proxy(actual, { get: (target, key) => (key === 'isWorkspacePane' ? pane.value : target[key as string]) })
})

import { Notify } from 'quasar'
import { useWebSocketStore } from '../stores/websocket'
import { useWorkspaceStore, type Workspace } from '../stores/workspace'
import { _resetRestoreWarningMemoryForTest, showRestoreWarnings } from '../utils/restore-warnings'

function warningsEvent(payload: unknown, workspaceId?: string) {
  useWebSocketStore()._routeMessage({
    type: 'workspace:restore-warnings',
    ...(workspaceId ? { workspaceId } : {}),
    payload,
  } as never)
}
const ev = (warnings: unknown, workspaceId = 'w1', workspaceName = 'My workspace') => ({
  workspaceId,
  workspaceName,
  warnings,
})
const messages = () => vi.mocked(Notify.create).mock.calls.map(([o]) => (o as { message: string }).message)

describe('global workspace:restore-warnings event', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.useRealTimers()
    _resetRestoreWarningMemoryForTest()
    pane.value = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json([])),
    )
  })

  it('shows one sticky toast per warning, prefixed with the workspace name', () => {
    warningsEvent(ev(['First problem.', 'Second problem.']))
    expect(Notify.create).toHaveBeenCalledTimes(2)
    expect(messages()[0]).toContain('My workspace: First problem.')
    expect(messages()[1]).toContain('My workspace: Second problem.')
    expect(vi.mocked(Notify.create).mock.calls[0]![0]).toMatchObject({
      type: 'warning',
      timeout: 0,
      closeBtn: true,
      multiLine: true,
    })
  })

  it('shows the warning alone when the name is missing or empty', () => {
    warningsEvent(ev(['Alone.'], 'w1', ''))
    warningsEvent({ workspaceId: 'w2', warnings: ['Alone too.'] })
    expect(messages()[0]).toBe('Worktree restored, with a warning: Alone.')
    expect(messages()[1]).toBe('Worktree restored, with a warning: Alone too.')
  })

  it('skips an identical event within 10 s and shows it again afterwards', () => {
    vi.useFakeTimers()
    warningsEvent(ev(['Same.']))
    warningsEvent(ev(['Same.']))
    expect(Notify.create).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10_001)
    warningsEvent(ev(['Same.']))
    expect(Notify.create).toHaveBeenCalledTimes(2)
  })

  it('does not merge the same text for different workspaces', () => {
    warningsEvent(ev(['Same.'], 'w1'))
    warningsEvent(ev(['Same.'], 'w2'))
    expect(Notify.create).toHaveBeenCalledTimes(2)
  })

  it.each([['the HTTP answer first'], ['the event first']])('shows one toast when both paths report: %s', (order) => {
    const $q = { notify: (o: unknown) => Notify.create(o as never) }
    const t = (_k: string, p?: Record<string, string>) => p?.message ?? ''
    const http = () => showRestoreWarnings($q, t, ['Same.'], { workspaceId: 'w1', workspaceName: 'My workspace' })
    if (order.startsWith('the HTTP')) {
      http()
      warningsEvent(ev(['Same.']))
    } else {
      warningsEvent(ev(['Same.']))
      http()
    }
    expect(Notify.create).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['null', null],
    ['a string', 'oops'],
    ['no warnings key', { workspaceId: 'w1' }],
    ['warnings not an array', ev('oops')],
    ['no workspace id', { warnings: ['x'] }],
    ['only non-strings', ev([1, null])],
  ])('ignores a malformed payload without throwing: %s', (_l, payload) => {
    expect(() => warningsEvent(payload)).not.toThrow()
    expect(Notify.create).not.toHaveBeenCalled()
  })

  it('shows nothing in an embedded pane', () => {
    pane.value = true
    warningsEvent(ev(['A problem.']))
    expect(Notify.create).not.toHaveBeenCalled()
  })

  it('shows the toasts even for a muted workspace', () => {
    useWorkspaceStore().workspaces = [
      { id: 'w1', name: 'W', notificationPrefs: { muteToast: true } } as unknown as Workspace,
    ]
    warningsEvent(ev(['A problem.']))
    expect(Notify.create).toHaveBeenCalledTimes(1)
  })

  it('does not toast from workspace:worktree-restored any more, even with a warnings key', () => {
    useWebSocketStore()._routeMessage({
      type: 'workspace:worktree-restored',
      workspaceId: 'w1',
      payload: { warnings: ['Ignored.'] },
    })
    expect(Notify.create).not.toHaveBeenCalled()
  })

  it('the copy action copies the bare sentence', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    warningsEvent(ev(['Bare sentence.']))
    const options = vi.mocked(Notify.create).mock.calls[0]![0] as {
      actions: Array<{ handler: () => void }>
    }
    options.actions[0]!.handler()
    await Promise.resolve()
    expect(writeText).toHaveBeenCalledWith('Bare sentence.')
  })
})
