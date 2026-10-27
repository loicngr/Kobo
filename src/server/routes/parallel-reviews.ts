import { type Context, Hono } from 'hono'
import { migrationGuard } from '../middleware/migration-guard.js'
import {
  cancelParallelReviewReturn,
  retryParallelReviewReturn,
  stopParallelReview,
} from '../services/agent/orchestrator.js'
import { getParallelReviewStatus } from '../services/parallel-review-service.js'
import { getWorkspace } from '../services/workspace-service.js'
import { assertAgentStopped } from '../utils/agent-stop-result.js'

async function readReviewSessionId(c: Context): Promise<string | null> {
  const body: unknown = await c.req.json().catch(() => null)
  return body &&
    typeof body === 'object' &&
    'sessionId' in body &&
    typeof body.sessionId === 'string' &&
    body.sessionId.trim()
    ? body.sessionId
    : null
}

const app = new Hono()
app.get('/:id/parallel-review', (c) => {
  if (!getWorkspace(c.req.param('id'))) return c.json({ error: 'Workspace not found' }, 404)
  return c.json(getParallelReviewStatus(c.req.param('id')))
})
app.post('/:id/parallel-review/stop', migrationGuard, async (c) => {
  try {
    const sessionId = await readReviewSessionId(c)
    if (!sessionId) return c.json({ error: 'sessionId is required in a valid JSON body' }, 400)
    assertAgentStopped(await stopParallelReview(c.req.param('id'), sessionId))
    return c.json({ ok: true })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 409)
  }
})
app.post('/:id/parallel-review/retry-return', migrationGuard, async (c) => {
  try {
    const sessionId = await readReviewSessionId(c)
    if (!sessionId) return c.json({ error: 'sessionId is required in a valid JSON body' }, 400)
    retryParallelReviewReturn(c.req.param('id'), sessionId)
    return c.json({ ok: true })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 409)
  }
})
app.post('/:id/parallel-review/cancel-return', migrationGuard, async (c) => {
  try {
    const sessionId = await readReviewSessionId(c)
    if (!sessionId) return c.json({ error: 'sessionId is required in a valid JSON body' }, 400)
    cancelParallelReviewReturn(c.req.param('id'), sessionId)
    return c.json({ ok: true })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 409)
  }
})
export default app
