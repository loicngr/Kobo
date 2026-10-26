import { Hono } from 'hono'
import { listEngines } from '../services/agent/engines/registry.js'
import { getMistralOptions } from '../services/mistral-options-service.js'

/** Hono sub-router exposing `GET /` — the list of registered agent engines with capabilities. */
export const enginesRouter = new Hono()

enginesRouter.get('/', (c) =>
  c.json(
    listEngines().map((e) => ({
      id: e.id,
      displayName: e.displayName,
      capabilities: e.capabilities,
    })),
  ),
)

enginesRouter.get('/mistral-vibe/options', async (c) => {
  try {
    return c.json(
      await getMistralOptions({
        workspaceId: c.req.query('workspaceId'),
        projectPath: c.req.query('projectPath'),
        model: c.req.query('model'),
        agentPermissionMode: c.req.query('agentPermissionMode'),
      }),
    )
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Native Vibe options unavailable' }, 400)
  }
})
