import { Hono } from 'hono'
import {
  DEFAULT_NOTION_INITIAL_PROMPT,
  DEFAULT_SENTRY_INITIAL_PROMPT,
} from '../services/initial-prompt-template-service.js'
import { DEFAULT_REVIEW_PROMPT_TEMPLATE } from '../services/review-template-service.js'
import * as settingsService from '../services/settings-service.js'
import {
  type ConfigBundle,
  DEFAULT_GIT_CONVENTIONS,
  DEFAULT_PR_PROMPT_TEMPLATE,
  type GlobalSettings,
  type ProjectSettings,
} from '../services/settings-service.js'
import { listTemplates, replaceAllTemplates } from '../services/templates-service.js'

/** Hono sub-router for global and per-project settings CRUD. */
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

// GET /api/settings/defaults — expose the in-code DEFAULT_* constants for
// global text-template settings (PR / review / git conventions / Notion /
// Sentry initial prompts) so the UI can offer a "reset to default" button
// without duplicating the strings on the frontend.
app.get('/defaults', (c) => {
  return c.json({
    prPromptTemplate: DEFAULT_PR_PROMPT_TEMPLATE,
    reviewPromptTemplate: DEFAULT_REVIEW_PROMPT_TEMPLATE,
    gitConventions: DEFAULT_GIT_CONVENTIONS,
    notionInitialPromptTemplate: DEFAULT_NOTION_INITIAL_PROMPT,
    sentryInitialPromptTemplate: DEFAULT_SENTRY_INITIAL_PROMPT,
  })
})

// GET /api/settings/mcp-servers — list active MCP servers from Claude config
app.get('/mcp-servers', (c) => {
  try {
    const servers = settingsService.listActiveClaudeMcpServers()
    return c.json(servers)
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
    const status = err instanceof Error && err.name === 'InvalidWorktreesPathError' ? 400 : 500
    return c.json({ error: message }, status)
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

// GET /api/settings/export — download a JSON bundle of settings + templates (MCP keys stripped)
app.get('/export', (c) => {
  try {
    const bundle = settingsService.exportConfigBundle(listTemplates() as unknown as Array<Record<string, unknown>>)
    return c.json(bundle)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// POST /api/settings/import — replace settings + templates from an uploaded bundle
app.post('/import', async (c) => {
  try {
    const body = (await c.req.json()) as ConfigBundle
    // Validate settings first — throws on malformed payload before we touch disk.
    settingsService.importConfigBundle(body)
    if (body.templates !== undefined) {
      // Accept missing templates (backward-compatible). Otherwise validate and replace.
      replaceAllTemplates(body.templates as unknown[])
    }
    return c.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const isValidation = message.includes('Invalid bundle') || message.includes('Invalid template')
    return c.json({ error: message }, isValidation ? 400 : 500)
  }
})

export default app
