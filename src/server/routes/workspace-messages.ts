import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { MAX_GROUP_MESSAGE_REQUEST_BYTES } from '../../shared/workspace-group-messages.js'
import {
  GroupMessageError,
  getGroupMessageBatch,
  startGroupMessageBatch,
} from '../services/workspace-group-message-service.js'

const app = new Hono()
app.use('*', bodyLimit({ maxSize: MAX_GROUP_MESSAGE_REQUEST_BYTES }))
app.post('/', async (c) => {
  const body: unknown = await c.req.json().catch(() => null)
  try {
    return c.json(startGroupMessageBatch(body), 202)
  } catch (error) {
    if (error instanceof GroupMessageError) return c.json({ error: error.message }, error.status)
    throw error
  }
})
app.get('/:id', (c) => {
  const batch = getGroupMessageBatch(c.req.param('id'))
  return batch ? c.json(batch) : c.json({ error: 'Group message not found' }, 404)
})
export default app
