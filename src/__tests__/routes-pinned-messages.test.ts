import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import router from '../server/routes/pinned-messages.js'
import {
  createPinnedMessage,
  deletePinnedMessage,
  getPinnedMessage,
  listPinnedMessages,
  PinnedMessageError,
} from '../server/services/pinned-message-service.js'

vi.mock('../server/services/pinned-message-service.js', async (original) => ({
  ...(await original<typeof import('../server/services/pinned-message-service.js')>()),
  createPinnedMessage: vi.fn(),
  deletePinnedMessage: vi.fn(),
  getPinnedMessage: vi.fn(),
  listPinnedMessages: vi.fn(),
}))
const app = new Hono().route('/api/pinned-messages', router)
beforeEach(() => vi.clearAllMocks())

describe('pinned message routes', () => {
  it('returns paginated summaries and details through the service', async () => {
    vi.mocked(listPinnedMessages).mockReturnValue({ pins: [], hasMore: false })
    const response = await app.request('/api/pinned-messages?workspaceId=w1&limit=25&offset=10')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ pins: [], hasMore: false })
    expect(listPinnedMessages).toHaveBeenCalledWith({ workspaceId: 'w1', limit: 25, offset: 10 })
    vi.mocked(getPinnedMessage).mockImplementation(() => {
      throw new PinnedMessageError('missing', 404)
    })
    expect((await app.request('/api/pinned-messages/missing')).status).toBe(404)
  })
  it('passes only input to server capture and reports errors', async () => {
    const body = { workspaceId: 'w1', eventIds: ['e1'] }
    vi.mocked(createPinnedMessage).mockImplementation(() => {
      throw new PinnedMessageError('too large', 413)
    })
    const response = await app.request('/api/pinned-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'too large' })
    expect(createPinnedMessage).toHaveBeenCalledWith(body)
    expect((await app.request('/api/pinned-messages', { method: 'POST', body: '{' })).status).toBe(400)
  })
  it('deletes without confirmation and returns the idempotent receipt', async () => {
    const response = await app.request('/api/pinned-messages/p1', { method: 'DELETE' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(deletePinnedMessage).toHaveBeenCalledWith('p1')
  })
})
