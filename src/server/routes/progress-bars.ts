import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { executeProgressBarTool, progressErrorData } from '../services/progress-bar-mcp-service.js'
import { resolveProgressCapability } from '../services/progress-bar-runtime.js'
import { dismissProgressBar, listProgressBars, ProgressBarError } from '../services/progress-bar-service.js'

const router = new Hono()
router.use('*', bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'Request body is too large' }, 413) }))
router.onError((error, c) => {
  if (error instanceof ProgressBarError) return c.json(progressErrorData(error), error.status)
  console.error('[progress-bars] Request failed', error)
  return c.json({ error: 'Progress request failed' }, 500)
})
router.post('/agent/:tool', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }
  // Stop may revoke the launch while the request body is being read. Resolve
  // only after the last await so authorization and mutation stay synchronous.
  const owner = resolveProgressCapability(c.req.header('X-Kobo-Progress-Session'))
  return c.json(executeProgressBarTool(c.req.param('tool'), body, owner))
})
router.get('/', (c) => {
  const workspaceId = c.req.query('workspaceId') ?? ''
  const sessionId = c.req.query('sessionId') ?? ''
  const limit = c.req.query('limit')
  const offset = c.req.query('offset')
  return c.json(
    listProgressBars({
      workspaceId,
      sessionId,
      limit: limit === undefined ? undefined : Number(limit),
      offset: offset === undefined ? undefined : Number(offset),
    }),
  )
})
router.post('/:id/dismiss', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'Expected an object' }, 400)
  const record = body as Record<string, unknown>
  if (
    Object.keys(record).some((key) => key !== 'workspaceId' && key !== 'sessionId') ||
    typeof record.workspaceId !== 'string' ||
    typeof record.sessionId !== 'string'
  )
    return c.json({ error: 'workspaceId and sessionId are required' }, 400)
  return c.json(dismissProgressBar({ workspaceId: record.workspaceId, sessionId: record.sessionId }, c.req.param('id')))
})
export default router
