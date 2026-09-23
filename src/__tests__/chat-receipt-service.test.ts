import { beforeEach, describe, expect, it, vi } from 'vitest'

const emit = vi.hoisted(() => vi.fn(() => 'persisted-event'))
const emitEphemeral = vi.hoisted(() => vi.fn())
vi.mock('../server/services/websocket-service.js', () => ({ emit, emitEphemeral }))

import { createChatReceipt } from '../server/services/chat-receipt-service.js'

beforeEach(() => vi.clearAllMocks())
describe('confirmed chat delivery', () => {
  it('correlates the persisted message and acceptance for an ordinary review', () => {
    createChatReceipt('ws', { content: 'review', clientMessageId: 'client-1' }).accept('session')
    expect(emit).toHaveBeenCalledWith(
      'ws',
      'user:message',
      { content: 'review', sender: 'user', clientMessageId: 'client-1' },
      'session',
      { requirePersistence: true },
    )
    expect(emitEphemeral).toHaveBeenCalledWith('ws', 'chat:accepted', {
      sessionId: 'session',
      clientMessageId: 'client-1',
    })
    expect(emit.mock.invocationCallOrder[0]).toBeLessThan(emitEphemeral.mock.invocationCallOrder[0])
  })
  it('preserves legacy unconfirmed delivery without a new acknowledgement', () => {
    createChatReceipt('ws', { content: 'hello' }).accept('session')
    expect(emitEphemeral).not.toHaveBeenCalled()
  })
  it('correlates rejections without persisting a user message', () => {
    createChatReceipt('ws', { content: 'review', clientMessageId: 'client-1', sessionId: 'session' }).reject(
      'busy',
      'compacting',
    )
    expect(emit).not.toHaveBeenCalled()
    expect(emitEphemeral).toHaveBeenCalledWith('ws', 'chat:rejected', {
      content: 'review',
      sessionId: 'session',
      clientMessageId: 'client-1',
      message: 'busy',
      reason: 'compacting',
    })
  })
})
