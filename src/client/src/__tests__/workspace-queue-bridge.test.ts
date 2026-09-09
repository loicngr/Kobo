import { createPinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'
import { attachWorkspaceQueueHost, createWorkspaceQueueHost } from '../services/workspace-queue-bridge'
import { useWebSocketStore } from '../stores/websocket'
import { useWorkspaceStore } from '../stores/workspace'

function setup() {
  const pinia = createPinia()
  const root = useWorkspaceStore(pinia)
  const paneA = useWorkspaceStore(createPinia())
  const paneB = useWorkspaceStore(createPinia())
  const host = createWorkspaceQueueHost(root)
  const send = vi.spyOn(useWebSocketStore(pinia), 'sendChatMessage').mockReturnValue(true)
  const detachA = attachWorkspaceQueueHost(paneA, host)
  const detachB = attachWorkspaceQueueHost(paneB, host)
  return {
    root,
    paneA,
    paneB,
    host,
    send,
    dispose: () => {
      detachA()
      detachB()
      host.dispose()
    },
  }
}
describe('shared workspace queues in split view', () => {
  it('shows a pre-existing normal-view queue and allows cancelling it from either pane', () => {
    const root = useWorkspaceStore(createPinia())
    root.queueMessage('w', 'instruction', 's')
    const host = createWorkspaceQueueHost(root)
    const pane = useWorkspaceStore(createPinia())
    const detach = attachWorkspaceQueueHost(pane, host)
    expect(pane.getQueuedMessage('w', 's')?.content).toBe('instruction')
    pane.cancelQueuedMessage('w', 's')
    expect(root.getQueuedMessage('w', 's')).toBeUndefined()
    detach()
    host.dispose()
  })
  it('keeps a single queue and sends only once when all three clients see session-ended', () => {
    const { root, paneA, paneB, send, dispose } = setup()
    paneA.queueMessage('w', 'first', 's')
    expect(paneB.getQueuedMessage('w', 's')?.content).toBe('first')
    paneB.queueMessage('w', 'replacement', 's')
    expect(root.getQueuedMessage('w', 's')?.content).toBe('replacement')
    paneA.flushQueuedMessage('w', 's')
    paneB.flushQueuedMessage('w', 's')
    root.flushQueuedMessage('w', 's')
    expect(send).toHaveBeenCalledExactlyOnceWith('w', 'replacement', 's')
    expect(paneA.queuedMessages).toEqual({})
    expect(paneB.queuedMessages).toEqual({})
    dispose()
  })
  it('does not consume the live queue while a new pane replays old session endings', () => {
    const root = useWorkspaceStore(createPinia())
    root.queueMessage('w', 'next instruction', 'session')
    const host = createWorkspaceQueueHost(root)
    const panePinia = createPinia()
    const pane = useWorkspaceStore(panePinia)
    const detach = attachWorkspaceQueueHost(pane, host)
    useWebSocketStore(panePinia)._routeMessage({
      type: 'sync:response',
      payload: {
        events: [
          {
            id: 'old-end',
            workspaceId: 'w',
            type: 'agent:event',
            sessionId: 'session',
            createdAt: '2026-01-01T00:00:00Z',
            payload: { kind: 'session:ended', reason: 'completed', exitCode: 0 },
          },
        ],
      },
    })
    expect(root.getQueuedMessage('w', 'session')?.content).toBe('next instruction')
    detach()
    host.dispose()
  })
  it('retains queues when panes close and isolates session keys', () => {
    const { root, paneA, paneB, dispose } = setup()
    paneA.queueMessage('w', 'one', 's1')
    paneB.queueMessage('w', 'two', 's2')
    dispose()
    expect(root.getQueuedMessage('w', 's1')?.content).toBe('one')
    expect(root.getQueuedMessage('w', 's2')?.content).toBe('two')
  })
})
