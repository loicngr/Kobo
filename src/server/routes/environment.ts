import { Hono } from 'hono'
import type { EnvironmentReport } from '../../shared/environment.js'
import { getEnvironmentReport } from '../services/environment-check-service.js'

const app = new Hono()

app.get('/', async (c) => {
  const engine = c.req.query('engine') ?? 'claude-code'
  const projectPath = c.req.query('projectPath')?.trim()
  if (
    !['claude-code', 'codex', 'mistral-vibe'].includes(engine) ||
    (projectPath && (projectPath.length > 4096 || projectPath.includes('\0')))
  ) {
    return c.json({ error: 'Invalid environment check request' }, 400)
  }
  try {
    return c.json(await getEnvironmentReport({ engine: engine as EnvironmentReport['engine'], projectPath }))
  } catch {
    return c.json({ error: 'Environment check unavailable; retry shortly' }, 503)
  }
})

export default app
