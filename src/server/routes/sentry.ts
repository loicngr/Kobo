import { Hono } from 'hono'
import { extractSentryIssue, testSentryConnection } from '../services/sentry-service.js'
import { getGlobalSettings } from '../services/settings-service.js'

/** Hono sub-router for Sentry issue extraction (preflight). */
const app = new Hono()

app.post('/test', async (c) => {
  try {
    if (!getGlobalSettings().sentryEnabled) return c.json({ error: 'Sentry integration is disabled in Settings' }, 403)
    return c.json(await testSentryConnection())
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

// POST /api/sentry/extract — extract a Sentry issue by URL
app.post('/extract', async (c) => {
  try {
    if (!getGlobalSettings().sentryEnabled) {
      return c.json({ error: 'Sentry integration is disabled in Settings' }, 403)
    }
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
