import { Hono } from 'hono'
import { extractNotionPage } from '../services/notion-service.js'

const app = new Hono()

// POST /api/notion/extract — extract a Notion page
app.post('/extract', async (c) => {
  try {
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
