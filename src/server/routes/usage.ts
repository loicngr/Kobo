import { Hono } from 'hono'
import { getDb } from '../db/index.js'
import { refreshNow } from '../services/usage/poller.js'
import { computeEngineReliability } from '../services/usage/reliability.js'
import type { ProviderId } from '../services/usage/types.js'

const app = new Hono()

// GET /api/usage/reliability — how each engine and model actually behaved.
app.get('/reliability', (c) => {
  try {
    return c.json({ engines: computeEngineReliability(getDb()) })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

app.post('/:providerId/refresh', async (c) => {
  const providerId = c.req.param('providerId') as ProviderId
  try {
    const snap = await refreshNow(providerId)
    if (!snap) {
      return c.json({ error: `Unknown provider '${providerId}'` }, 404)
    }
    return c.json({ snapshot: snap }, 200)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

export default app
