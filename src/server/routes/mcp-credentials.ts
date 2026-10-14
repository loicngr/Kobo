import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  createExternalMcpCredential,
  EXTERNAL_TOOL_CATALOGUE,
  listExternalMcpCredentials,
  revokeExternalMcpCredential,
} from '../services/external-mcp-credentials-service.js'

// Mounted behind the operator authentication gate; MCP credentials cannot reach it.
const app = new Hono()
app.use('*', bodyLimit({ maxSize: 32 * 1024 }))
app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  await next()
})
app.get('/', (c) =>
  c.json({
    credentials: listExternalMcpCredentials(),
    tools: EXTERNAL_TOOL_CATALOGUE.map((tool) => ({
      name: tool.name,
      readOnly: tool.annotations?.readOnlyHint === true,
    })),
  }),
)
app.post('/', async (c) => {
  try {
    return c.json(createExternalMcpCredential(await c.req.json()), 201)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Invalid credential request' }, 400)
  }
})
app.delete('/:id', (c) => {
  revokeExternalMcpCredential(c.req.param('id'))
  return c.json({ ok: true })
})
export default app
