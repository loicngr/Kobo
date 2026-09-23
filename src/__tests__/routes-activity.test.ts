import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/services/activity-service.js', () => ({
  activityCursor: vi.fn(() => 7),
  listActivity: vi.fn(() => ({ items: [], nextCursor: 0, cursor: 7, hasMore: false })),
}))

import app from '../server/routes/activity.js'
import { listActivity } from '../server/services/activity-service.js'

beforeEach(() => vi.clearAllMocks())
describe('activity API', () => {
  it('reads only the cursor for an active visit heartbeat', async () => {
    expect(await (await app.request('/?head=1')).json()).toEqual({ cursor: 7 })
    expect(listActivity).not.toHaveBeenCalled()
  })
  it.each(['-1', '1.2', 'bad', '9007199254740992'])('rejects invalid after cursor %s', async (after) => {
    expect((await app.request(`/?after=${after}`)).status).toBe(400)
  })
  it('passes the validated cursor to the bounded feed', async () => {
    expect((await app.request('/?after=4')).status).toBe(200)
    expect(listActivity).toHaveBeenCalledWith(4)
  })
})
