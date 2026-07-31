import { Hono } from 'hono'
import { extractNotionPage, listNotionUsers, testNotionConnection } from '../services/notion-service.js'
import { getGlobalSettings } from '../services/settings-service.js'

/** Hono sub-router for Notion page extraction. */
const app = new Hono()

app.post('/test', async (c) => {
  try {
    if (!getGlobalSettings().notionEnabled) return c.json({ error: 'Notion integration is disabled in Settings' }, 403)
    return c.json(await testNotionConnection())
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})

// GET /api/notion/users — list workspace users (humans only, for the settings dropdown)
app.get('/users', async (c) => {
  try {
    if (!getGlobalSettings().notionEnabled) {
      return c.json({ error: 'Notion integration is disabled in Settings' }, 403)
    }
    const users = await listNotionUsers()
    return c.json({ users })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// POST /api/notion/extract — extract a Notion page
app.post('/extract', async (c) => {
  try {
    if (!getGlobalSettings().notionEnabled) {
      return c.json({ error: 'Notion integration is disabled in Settings' }, 403)
    }
    const body = await c.req.json<{ url: string }>()

    if (!body.url) {
      return c.json({ error: 'Missing required field: url' }, 400)
    }

    const content = await extractNotionPage(body.url)

    return c.json({
      title: content.title,
      goal: content.goal,
      todos: content.todos,
      gherkinFeatures: content.gherkinFeatures,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

export default app
