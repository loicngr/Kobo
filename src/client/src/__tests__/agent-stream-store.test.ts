import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

describe('agent-stream store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('appends events into a per-workspace list', async () => {
    const { useAgentStreamStore } = await import('../stores/agent-stream.js')
    const store = useAgentStreamStore()
    store.append('w1', { kind: 'message:text', messageId: 'm', text: 'hi', streaming: false })
    store.append('w1', { kind: 'message:end', messageId: 'm' })
    store.append('w2', { kind: 'message:text', messageId: 'n', text: 'there', streaming: false })
    expect(store.eventsFor('w1')).toHaveLength(2)
    expect(store.eventsFor('w2')).toHaveLength(1)
  })

  it('reset replaces the event list for a workspace (used on sync:response)', async () => {
    const { useAgentStreamStore } = await import('../stores/agent-stream.js')
    const store = useAgentStreamStore()
    store.append('w1', { kind: 'message:text', messageId: 'm', text: 'old', streaming: false })
    store.reset('w1', [{ kind: 'message:text', messageId: 'n', text: 'new', streaming: false }])
    const events = store.eventsFor('w1')
    expect(events).toHaveLength(1)
    expect((events[0] as { text: string }).text).toBe('new')
  })

  it('clear removes all events for a workspace', async () => {
    const { useAgentStreamStore } = await import('../stores/agent-stream.js')
    const store = useAgentStreamStore()
    store.append('w1', { kind: 'message:text', messageId: 'm', text: 'x', streaming: false })
    store.clear('w1')
    expect(store.eventsFor('w1')).toEqual([])
  })
})
