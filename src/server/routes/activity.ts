import { Hono } from 'hono'
import { activityCursor, listActivity } from '../services/activity-service.js'

const app = new Hono()
app.get('/', (c) => {
  try {
    if (c.req.query('head') === '1') return c.json({ cursor: activityCursor() })
    const raw = c.req.query('after') ?? '0'
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
      return c.json({ error: 'after must be a non-negative integer' }, 400)
    return c.json(listActivity(Number(raw)))
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500)
  }
})
export default app
