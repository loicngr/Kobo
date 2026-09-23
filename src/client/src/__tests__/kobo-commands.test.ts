import { createPinia, setActivePinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import type { useWebSocketStore } from '../stores/websocket'
import type { useWorkspaceStore } from '../stores/workspace'
import { sendPrepAutoloop } from '../utils/kobo-commands'

afterEach(() => vi.unstubAllGlobals())
it.each(['plan', 'strict', 'interactive', 'bypass'])(
  'preserves %s permissions during grooming without a message override',
  async (mode) => {
    setActivePinia(createPinia())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ prompt: 'groom' }) }))
    const sockets = { sendChatMessage: vi.fn() }
    const workspaces = {
      workspaces: [{ id: 'one', agentPermissionMode: mode }],
      updateAgentPermissionMode: vi.fn(),
      markRead: vi.fn(),
      addActivityItem: vi.fn(),
    }
    await sendPrepAutoloop(
      'one',
      sockets as unknown as ReturnType<typeof useWebSocketStore>,
      workspaces as unknown as ReturnType<typeof useWorkspaceStore>,
    )
    expect(workspaces.updateAgentPermissionMode).not.toHaveBeenCalled()
    expect(sockets.sendChatMessage).toHaveBeenCalledWith('one', 'groom')
  },
)

it('preserves permissions when prompt lookup fails', async () => {
  setActivePinia(createPinia())
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  const sockets = { sendChatMessage: vi.fn() }
  const workspaces = {
    workspaces: [{ id: 'one', agentPermissionMode: 'plan' }],
    updateAgentPermissionMode: vi.fn(),
    markRead: vi.fn(),
    addActivityItem: vi.fn(),
  }
  await sendPrepAutoloop(
    'one',
    sockets as unknown as ReturnType<typeof useWebSocketStore>,
    workspaces as unknown as ReturnType<typeof useWorkspaceStore>,
  )
  expect(workspaces.updateAgentPermissionMode).not.toHaveBeenCalled()
  expect(sockets.sendChatMessage.mock.calls[0]).toHaveLength(2)
})
