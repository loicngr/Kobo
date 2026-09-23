import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../server/services/agent/engines/types.js'
import { createStreamingBatcher } from '../server/services/agent/streaming-batcher.js'

describe('createStreamingBatcher', () => {
  it('combines streaming fragments of one message', () => {
    vi.useFakeTimers()
    const events: AgentEvent[] = []
    const batcher = createStreamingBatcher((event) => events.push(event), { windowMs: 40 })
    batcher.push({ kind: 'message:text', messageId: 'm1', text: 'Bon', streaming: true })
    batcher.push({ kind: 'message:text', messageId: 'm1', text: 'jour', streaming: true })
    vi.advanceTimersByTime(40)
    expect(events).toEqual([{ kind: 'message:text', messageId: 'm1', text: 'Bonjour', streaming: true }])
    vi.useRealTimers()
  })

  it('flushes text before ending its message', () => {
    const events: AgentEvent[] = []
    const batcher = createStreamingBatcher((event) => events.push(event))
    batcher.push({ kind: 'message:text', messageId: 'm1', text: 'Bonjour', streaming: true })
    batcher.push({ kind: 'message:end', messageId: 'm1' })
    expect(events.map((event) => event.kind)).toEqual(['message:text', 'message:end'])
  })
})
