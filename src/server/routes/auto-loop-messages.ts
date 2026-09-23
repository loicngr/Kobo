import { Hono } from 'hono'
import { listLoopMessages, resolveLoopMessage } from '../services/auto-loop-message-service.js'
import { deliverWorkspaceMessage } from '../services/workspace-message-service.js'
import { getWorkspace } from '../services/workspace-service.js'
import { assertWorkspaceLifecycleAvailable } from '../utils/workspace-lifecycle-guard.js'

const app = new Hono()
app.get('/:id/auto-loop/messages', (c) => {
  try {
    const id = c.req.param('id')
    if (!getWorkspace(id)) return c.json({ error: 'Workspace not found' }, 404)
    return c.json(listLoopMessages(id))
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
})
app.post('/:id/auto-loop/messages', async (c) => {
  try {
    const body = await c.req.json()
    if (typeof body.content !== 'string' || typeof body.clientMessageId !== 'string')
      return c.json({ error: 'content and clientMessageId are required' }, 400)
    await deliverWorkspaceMessage(c.req.param('id'), {
      content: body.content,
      clientMessageId: body.clientMessageId,
      delivery: 'next_iteration',
    })
    return c.json({ accepted: true })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
})
app.patch('/:id/auto-loop/messages/:messageId', async (c) => {
  try {
    const id = c.req.param('id')
    assertWorkspaceLifecycleAvailable(id)
    const workspace = getWorkspace(id)
    if (!workspace || workspace.archivedAt || workspace.worktreePurgedAt)
      return c.json({ error: 'Workspace unavailable' }, 409)
    const { action } = await c.req.json()
    if (!['cancel', 'acknowledge', 'retry'].includes(action)) return c.json({ error: 'Invalid resolution' }, 400)
    resolveLoopMessage(id, Number(c.req.param('messageId')), action)
    return c.json({ ok: true })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
})
export default app
