import { Hono } from 'hono'
import type { GlobalSettings, ProjectSettings } from '../services/settings-service.js'
import * as settingsService from '../services/settings-service.js'

const app = new Hono()

// GET /api/settings — return full settings
app.get('/', (c) => {
  try {
    const settings = settingsService.getSettings()
    return c.json(settings)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// GET /api/settings/global — return global settings
app.get('/global', (c) => {
  try {
    const global = settingsService.getGlobalSettings()
    return c.json(global)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// PUT /api/settings/global — update global settings
app.put('/global', async (c) => {
  try {
    const body = await c.req.json<Partial<GlobalSettings>>()
    const updated = settingsService.updateGlobalSettings(body)
    return c.json(updated)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// GET /api/settings/projects — list all projects
app.get('/projects', (c) => {
  try {
    const projects = settingsService.listProjects()
    return c.json(projects)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// GET /api/settings/projects/:encodedPath — get project by path
app.get('/projects/:encodedPath', (c) => {
  try {
    const encodedPath = c.req.param('encodedPath')
    const projectPath = Buffer.from(encodedPath, 'base64url').toString()
    const project = settingsService.getProjectSettings(projectPath)

    if (!project) {
      return c.json({ error: `Project not found: '${projectPath}'` }, 404)
    }

    return c.json(project)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// PUT /api/settings/projects/:encodedPath — add or update project
app.put('/projects/:encodedPath', async (c) => {
  try {
    const encodedPath = c.req.param('encodedPath')
    const projectPath = Buffer.from(encodedPath, 'base64url').toString()
    const body = await c.req.json<Partial<Omit<ProjectSettings, 'path'>>>()
    const project = settingsService.upsertProject(projectPath, body)
    return c.json(project)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// DELETE /api/settings/projects/:encodedPath — remove project
app.delete('/projects/:encodedPath', (c) => {
  try {
    const encodedPath = c.req.param('encodedPath')
    const projectPath = Buffer.from(encodedPath, 'base64url').toString()
    settingsService.deleteProject(projectPath)
    return new Response(null, { status: 204 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

export default app
