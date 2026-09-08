import { Hono } from 'hono'
import * as templates from '../services/workspace-template-service.js'

/** Saved presets of the create-workspace form. */
const app = new Hono()

/** Service errors carry their meaning in the message; everything else is a 500. */
function statusFor(message: string): 400 | 409 | 422 | 500 {
  if (message.startsWith('Invalid template name')) return 400
  if (/^Template '.*' already exists$/.test(message)) return 409
  if (message.startsWith('Too many templates')) return 422
  return 500
}

app.get('/', (c) => {
  try {
    return c.json({ templates: templates.listWorkspaceTemplates() })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

app.post('/', async (c) => {
  try {
    const body = await c.req.json<{ name?: unknown; preset?: unknown }>().catch(() => null)
    if (!body || typeof body.name !== 'string') return c.json({ error: 'name is required' }, 400)
    const template = templates.createWorkspaceTemplate({ name: body.name, preset: body.preset ?? {} })
    return c.json({ template }, 201)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, statusFor(message))
  }
})

app.put('/:id', async (c) => {
  try {
    const body = await c.req.json<{ name?: unknown; preset?: unknown }>().catch(() => null)
    if (!body) return c.json({ error: 'Invalid JSON body' }, 400)
    const updates: { name?: string; preset?: unknown } = {}
    if (typeof body.name === 'string') updates.name = body.name
    if (body.preset !== undefined) updates.preset = body.preset
    const template = templates.updateWorkspaceTemplate(c.req.param('id'), updates)
    if (!template) return c.json({ error: `Template '${c.req.param('id')}' not found` }, 404)
    return c.json({ template })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, statusFor(message))
  }
})

app.delete('/:id', (c) => {
  try {
    if (!templates.deleteWorkspaceTemplate(c.req.param('id'))) {
      return c.json({ error: `Template '${c.req.param('id')}' not found` }, 404)
    }
    return c.body(null, 204)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

export default app
