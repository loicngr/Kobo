import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  createPinnedMessage,
  deletePinnedMessage,
  getPinnedMessage,
  listPinnedMessages,
  PinnedMessageError,
} from '../services/pinned-message-service.js'

const router = new Hono()
router.use(
  '*',
  bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: 'Request body is too large' }, 413) }),
)
router.onError((error, c) => {
  if (error instanceof PinnedMessageError) return c.json({ error: error.message }, error.status)
  console.error('[pinned-messages] Request failed', error)
  return c.json({ error: 'Pinned message request failed' }, 500)
})
router.get('/', (c) => {
  const limit = c.req.query('limit')
  const offset = c.req.query('offset')
  return c.json(
    listPinnedMessages({
      workspaceId: c.req.query('workspaceId'),
      limit: limit === undefined ? undefined : Number(limit),
      offset: offset === undefined ? undefined : Number(offset),
    }),
  )
})
router.post('/', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }
  return c.json(createPinnedMessage(body))
})
router.get('/:id', (c) => c.json(getPinnedMessage(c.req.param('id'))))
router.delete('/:id', (c) => {
  deletePinnedMessage(c.req.param('id'))
  return c.json({ ok: true })
})
export default router
