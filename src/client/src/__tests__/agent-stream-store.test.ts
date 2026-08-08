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

  it('bounds live append history while retaining a cursor for older pagination', async () => {
    const { MAX_LIVE_EVENTS_PER_WORKSPACE, useAgentStreamStore } = await import('../stores/agent-stream.js')
    const store = useAgentStreamStore()
    for (let i = 0; i <= MAX_LIVE_EVENTS_PER_WORKSPACE; i++) {
      store.append('w1', { kind: 'message:end', messageId: `m-${i}` }, undefined, `event-${i}`)
    }

    expect(store.eventsFor('w1')).toHaveLength(MAX_LIVE_EVENTS_PER_WORKSPACE)
    expect(store.eventIdsFor('w1')[0]).toBe('event-1')
    expect(store.oldestIdFor('w1')).toBe('event-1')
    expect(store.hasMoreOlderFor('w1')).toBe(true)
  })
})
