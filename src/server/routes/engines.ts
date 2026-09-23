import { Hono } from 'hono'
import { listEngines } from '../services/agent/engines/registry.js'

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
