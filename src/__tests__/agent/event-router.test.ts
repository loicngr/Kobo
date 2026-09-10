import { describe, expect, it, vi } from 'vitest'

vi.mock('../../server/services/websocket-service.js', () => ({
  emit: vi.fn(),
  emitEphemeral: vi.fn(),
}))

describe('routeEvent', () => {
  it('emits agent:event with the AgentEvent payload', async () => {
    const { routeEvent } = await import('../../server/services/agent/event-router.js')
    const ws = await import('../../server/services/websocket-service.js')
    routeEvent('w1', 's1', { kind: 'message:text', messageId: 'm', text: 't', streaming: false })
    expect(ws.emit).toHaveBeenCalledWith(
      'w1',
      'agent:event',
      {
        kind: 'message:text',
        messageId: 'm',
        text: 't',
        streaming: false,
      },
      's1',
    )
  })
})

it('tags transient compaction signals with their owning session', async () => {
  const { routeEvent } = await import('../../server/services/agent/event-router.js')
  const ws = await import('../../server/services/websocket-service.js')
  routeEvent('w1', 's1', { kind: 'session:compacting', active: true })
  expect(ws.emitEphemeral).toHaveBeenCalledWith('w1', 'agent:event', { kind: 'session:compacting', active: true }, 's1')
})
