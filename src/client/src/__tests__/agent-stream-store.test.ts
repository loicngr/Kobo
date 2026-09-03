import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

  it('does not bump a workspace version when another workspace receives an event', async () => {
    const { useAgentStreamStore } = await import('../stores/agent-stream.js')
    const store = useAgentStreamStore()
    store.append('w1', { kind: 'message:text', messageId: 'm', text: 'hi', streaming: true })

    const before = store.versionFor('w1')
    for (let i = 0; i < 50; i++) {
      store.append('w2', { kind: 'message:text', messageId: 'n', text: '.', streaming: true })
    }

    // A burst on a background workspace must not invalidate the foreground one:
    // WorkspaceList subscribes to EVERY workspace, so this happened constantly.
    expect(store.versionFor('w1')).toBe(before)
    expect(store.versionFor('w2')).toBeGreaterThan(before)
  })

  it('never scans the id array to deduplicate an append', async () => {
    const { useAgentStreamStore } = await import('../stores/agent-stream.js')
    const store = useAgentStreamStore()
    for (let i = 0; i < 1000; i++) {
      store.append('w1', { kind: 'message:end', messageId: `m-${i}` }, undefined, `evt-${i}`)
    }

    const includesSpy = vi.spyOn(Array.prototype, 'includes')
    store.append('w1', { kind: 'message:end', messageId: 'm-new' }, undefined, 'evt-new')
    const scannedForTheNewId = includesSpy.mock.calls.some((call) => call[0] === 'evt-new')
    includesSpy.mockRestore()

    expect(scannedForTheNewId).toBe(false)
    expect(store.eventsFor('w1')).toHaveLength(1001)
  })

  it('still rejects a duplicate event id after a thousand appends', async () => {
    const { useAgentStreamStore } = await import('../stores/agent-stream.js')
    const store = useAgentStreamStore()
    for (let i = 0; i < 1000; i++) {
      store.append('w1', { kind: 'message:end', messageId: `m-${i}` }, undefined, `evt-${i}`)
    }
    store.append('w1', { kind: 'message:end', messageId: 'm-0' }, undefined, 'evt-0')
    expect(store.eventsFor('w1')).toHaveLength(1000)
  })

  it('forgets the ids it trimmed so old history can be re-delivered', async () => {
    const { MAX_LIVE_EVENTS_PER_WORKSPACE, useAgentStreamStore } = await import('../stores/agent-stream.js')
    const store = useAgentStreamStore()
    for (let i = 0; i < MAX_LIVE_EVENTS_PER_WORKSPACE + 1; i++) {
      store.append('w1', { kind: 'message:end', messageId: `m-${i}` }, undefined, `evt-${i}`)
    }
    // `evt-0` was trimmed off the front — the index must have dropped it too,
    // otherwise it could never be re-appended after a reconnect replay.
    expect(store.eventIdsFor('w1')).not.toContain('evt-0')
    store.append('w1', { kind: 'message:end', messageId: 'm-0' }, undefined, 'evt-0')
    expect(store.eventIdsFor('w1')).toContain('evt-0')
  })

  it('rebuilds the id index on reset so a stale id never blocks a fresh event', async () => {
    const { useAgentStreamStore } = await import('../stores/agent-stream.js')
    const store = useAgentStreamStore()
    store.append('w1', { kind: 'message:end', messageId: 'm-old' }, undefined, 'evt-old')
    store.reset('w1', [{ kind: 'message:end', messageId: 'm-new' }], ['2026-01-01T00:00:00Z'], {
      eventIds: ['evt-new'],
      sessionIds: [null],
    })
    store.append('w1', { kind: 'message:end', messageId: 'm-old' }, undefined, 'evt-old')
    expect(store.eventIdsFor('w1')).toEqual(['evt-new', 'evt-old'])
  })

  it('drops an id from the index when the event is removed', async () => {
    const { useAgentStreamStore } = await import('../stores/agent-stream.js')
    const store = useAgentStreamStore()
    store.append('w1', { kind: 'message:end', messageId: 'm-1' }, undefined, 'evt-1')
    store.removeByEventId('w1', 'evt-1')
    store.append('w1', { kind: 'message:end', messageId: 'm-1' }, undefined, 'evt-1')
    expect(store.eventIdsFor('w1')).toEqual(['evt-1'])
  })

  it('reset() enforces the live-events cap like append/merge do', async () => {
    const { MAX_LIVE_EVENTS_PER_WORKSPACE, useAgentStreamStore } = await import('../stores/agent-stream.js')
    const store = useAgentStreamStore()
    const oversized = Array.from({ length: MAX_LIVE_EVENTS_PER_WORKSPACE + 10 }, (_, i) => ({
      kind: 'message:end' as const,
      messageId: `m${i}`,
    }))
    store.reset('w1', oversized)
    expect(store.eventsFor('w1').length).toBeLessThanOrEqual(MAX_LIVE_EVENTS_PER_WORKSPACE)
  })
})
