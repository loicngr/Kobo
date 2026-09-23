import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  getIntegrationStatus,
  type IntegrationId,
  saveIntegrationConfig,
} from '../services/integration-config-service.js'

const app = new Hono()
app.use('*', bodyLimit({ maxSize: 64 * 1024 }))
app.use('/:integration', async (c, next) => {
  if (!['notion', 'sentry'].includes(c.req.param('integration') ?? ''))
    return c.json({ error: 'Unknown integration' }, 404)
  await next()
})
app.get('/:integration', (c) => {
  try {
    return c.json(getIntegrationStatus(c.req.param('integration') as IntegrationId))
  } catch {
    return c.json({ error: 'Integration configuration is unavailable' }, 503)
  }
})
app.put('/:integration', async (c) => {
  try {
    const value: unknown = await c.req.json()
    saveIntegrationConfig(c.req.param('integration') as IntegrationId, value)
    return c.json(getIntegrationStatus(c.req.param('integration') as IntegrationId))
  } catch {
    return c.json(
      { error: 'Cannot save integration configuration; check the connection fields and local storage' },
      400,
    )
  }
})
export default app
