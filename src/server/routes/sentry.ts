import { Hono } from 'hono'
import { extractSentryIssue } from '../services/sentry-service.js'

/** Hono sub-router for Sentry issue extraction (preflight). */
const app = new Hono()

// POST /api/sentry/extract — extract a Sentry issue by URL
app.post('/extract', async (c) => {
  try {
    const body = await c.req.json<{ url: string }>()

    if (!body.url) {
      return c.json({ error: 'Missing required field: url' }, 400)
    }

    const content = await extractSentryIssue(body.url)
    return c.json(content)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

export default app
