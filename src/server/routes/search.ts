import { Hono } from 'hono'
import { getSearchIndexStatus, searchEvents } from '../services/search-service.js'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

const app = new Hono()

// GET /api/search?q=...&limit=50&includeArchived=true
// Search readable text across ws_events (user messages + agent outputs),
// joined with workspaces. Returns up to `limit` snippets, most recent first.
app.get('/status', (c) => {
  try {
    return c.json(getSearchIndexStatus())
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 503)
  }
})

app.get('/', async (c) => {
  const qRaw = c.req.query('q') ?? ''
  const q = qRaw.trim()
  if (!q) {
    return c.json({ error: "Missing or empty 'q' query parameter" }, 400)
  }

  let limit = DEFAULT_LIMIT
  const limitRaw = c.req.query('limit')
  if (limitRaw) {
    const parsed = parseInt(limitRaw, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      limit = Math.min(parsed, MAX_LIMIT)
    }
  }

  const includeArchived = c.req.query('includeArchived') === 'true'

  try {
    const results = await searchEvents(q, { limit, includeArchived }, c.req.raw.signal)
    c.header('X-Kobo-Search-Partial', String(getSearchIndexStatus().state !== 'ready'))
    return c.json(results)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 503)
  }
})

export default app
