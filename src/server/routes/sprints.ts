import { type Context, Hono } from 'hono'
import { migrationGuard } from '../middleware/migration-guard.js'
import * as sprints from '../services/sprint-service.js'
import { WorkspaceLifecycleBusyError } from '../utils/workspace-lifecycle-guard.js'

const app = new Hono()
app.use('*', (c, next) => (c.req.method === 'GET' ? next() : migrationGuard(c, next)))
function field(body: unknown, key: string): unknown {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !Object.hasOwn(body, key)
  )
    throw new Error(`Expected ${key}`)
  return (body as Record<string, unknown>)[key]
}
function failure(c: Context, error: unknown) {
  const message = error instanceof Error ? error.message : 'Sprint operation failed'
  return c.json(
    { error: message },
    error instanceof WorkspaceLifecycleBusyError ? 409 : message.endsWith('not found') ? 404 : 400,
  )
}
app.get('/', (c) => c.json({ sprints: sprints.listSprints() }))
app.post('/', async (c) => {
  try {
    const body = await c.req.json()
    return c.json({ sprint: sprints.createSprint(field(body, 'name')) }, 201)
  } catch (err) {
    return failure(c, err)
  }
})
app.post('/reorder', async (c) => {
  try {
    const body = await c.req.json()
    return c.json({ sprints: sprints.reorderSprints(field(body, 'ids')) })
  } catch (err) {
    return failure(c, err)
  }
})
app.patch('/:id', async (c) => {
  try {
    const body = await c.req.json()
    return c.json({ sprint: sprints.renameSprint(c.req.param('id'), field(body, 'name')) })
  } catch (err) {
    return failure(c, err)
  }
})
app.delete('/:id', (c) => {
  try {
    return c.json({ workspaceIds: sprints.deleteSprint(c.req.param('id')) })
  } catch (err) {
    return failure(c, err)
  }
})
export default app
