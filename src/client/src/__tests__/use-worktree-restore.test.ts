import { beforeEach, describe, expect, it, vi } from 'vitest'

const { notify, restore, store, FakeActionError } = vi.hoisted(() => {
  const restore = vi.fn()
  class FakeActionError extends Error {
    constructor(
      message: string,
      public code?: string,
    ) {
      super(message)
    }
  }
  return {
    notify: vi.fn(),
    restore,
    store: {
      restoringWorktreeIds: [] as string[],
      restoreWorktree: restore,
      workspaces: [{ id: 'w1', name: 'Named' }],
      archivedWorkspaces: [] as Array<{ id: string; name: string }>,
    },
    FakeActionError,
  }
})

const { copy } = vi.hoisted(() => ({ copy: vi.fn() }))
vi.mock('src/utils/clipboard', () => ({ copyToClipboard: copy }))
vi.mock('quasar', () => ({ useQuasar: () => ({ notify }) }))
vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) => (params?.message ? `${key}|${params.message}` : key),
  }),
}))
vi.mock('src/stores/workspace', () => ({
  useWorkspaceStore: () => store,
  WorkspaceActionError: FakeActionError,
}))

import { useWorktreeRestore } from '../composables/use-worktree-restore'
import { _resetRestoreWarningMemoryForTest } from '../utils/restore-warnings'

describe('useWorktreeRestore feedback', () => {
  beforeEach(() => {
    notify.mockReset()
    _resetRestoreWarningMemoryForTest()
    copy.mockReset()
    restore.mockReset()
    store.restoringWorktreeIds = []
  })

  it('shows the positive toast when there is no warning', async () => {
    restore.mockResolvedValue({ warnings: [] })
    await useWorktreeRestore().restoreWorktree('w1')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'positive' }))
  })

  it('shows one warning toast per warning and no positive toast', async () => {
    restore.mockResolvedValue({ warnings: ['The kept .ai folder could not be moved back.', 'Second one.'] })
    await useWorktreeRestore().restoreWorktree('w1')
    expect(notify).toHaveBeenCalledTimes(2)
    for (const [call, text] of [
      [notify.mock.calls[0]![0], 'The kept .ai folder could not be moved back.'],
      [notify.mock.calls[1]![0], 'Second one.'],
    ] as const) {
      expect(call).toMatchObject({
        type: 'warning',
        message: `workspacePage.worktreeRestoreWarning|Named: ${text}`,
        position: 'top',
        multiLine: true,
      })
      expect(call.timeout).toBe(0)
      expect(call.closeBtn).toBe(true)
      expect(call.actions.map((a: { icon?: string; label?: string }) => a.icon ?? a.label)).toEqual(['content_copy'])
    }
    expect(notify.mock.calls.some(([o]) => o.type === 'positive')).toBe(false)
  })

  it('copies a warning through the shared clipboard helper', async () => {
    restore.mockResolvedValue({ warnings: ['Copy me.'] })
    await useWorktreeRestore().restoreWorktree('w1')
    notify.mock.calls[0]![0].actions[0].handler()
    expect(copy).toHaveBeenCalledWith(expect.anything(), expect.any(Function), 'Copy me.')
    expect(notify.mock.calls[0]![0].message).toContain('Named: Copy me.')
  })

  it('keeps the error handling unchanged', async () => {
    restore.mockRejectedValue(new FakeActionError('x', 'path-conflict'))
    await useWorktreeRestore().restoreWorktree('w1')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'negative', message: 'workspacePage.restoreError.path-conflict' }),
    )
  })

  it('does nothing while a restore of the same workspace is running', async () => {
    store.restoringWorktreeIds = ['w1']
    await useWorktreeRestore().restoreWorktree('w1')
    expect(restore).not.toHaveBeenCalled()
  })
})
