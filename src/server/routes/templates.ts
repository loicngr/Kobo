import { Hono } from 'hono'
import * as templatesService from '../services/templates-service.js'

/** Hono sub-router for prompt templates CRUD. */
const app = new Hono()

// GET /api/templates — list all templates
app.get('/', (c) => {
  try {
    return c.json({ templates: templatesService.listTemplates() })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

/**
 * Classify a service error into the correct HTTP status based on the error
 * message markers exported by templates-service.ts. Unknown / I/O errors
 * fall through to 500 so disk-full or permission failures are not disguised
 * as client errors.
 */
function statusForServiceError(message: string): 400 | 409 | 500 {
  if (message.includes('already exists')) return 409
  if (message.startsWith('Invalid ')) return 400
  return 500
}

// POST /api/templates — create a new template
app.post('/', async (c) => {
  try {
    const body = await c.req
      .json<{ slug?: string; description?: string; content?: string }>()
      .catch(() => ({}) as { slug?: string; description?: string; content?: string })
    if (!body.slug || !body.description || !body.content) {
      return c.json({ error: 'slug, description, and content are required' }, 400)
    }
    const template = templatesService.createTemplate({
      slug: body.slug,
      description: body.description,
      content: body.content,
    })
    return c.json(template, 201)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, statusForServiceError(message))
  }
})

// PATCH /api/templates/:slug — update description and/or content
app.patch('/:slug', async (c) => {
  try {
    const slug = c.req.param('slug')
    const body = await c.req
      .json<{ description?: string; content?: string }>()
      .catch(() => ({}) as { description?: string; content?: string })
    const updated = templatesService.updateTemplate(slug, body)
    if (!updated) {
      return c.json({ error: `Template '${slug}' not found` }, 404)
    }
    return c.json(updated)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, statusForServiceError(message))
  }
})

// DELETE /api/templates/:slug — delete a template
app.delete('/:slug', (c) => {
  try {
    const slug = c.req.param('slug')
    const ok = templatesService.deleteTemplate(slug)
    if (!ok) {
      return c.json({ error: `Template '${slug}' not found` }, 404)
    }
    return c.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

export default app
