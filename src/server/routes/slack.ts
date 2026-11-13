import { type Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { isSlackQuestionMirror } from '../../shared/slack-question-mirror.js'
import { saveSlackCredentials } from '../services/slack/slack-credentials.js'
import {
  getSlackStatus,
  linkSlackChannel,
  listSlackChannels,
  restartSlack,
  setSlackQuestionMirror,
} from '../services/slack/slack-service.js'
import { WorkspaceLifecycleBusyError } from '../utils/workspace-lifecycle-guard.js'

/** Operator routes for the Slack integration. Responses never carry tokens or raw Slack errors. */
const app = new Hono()
const SLACK_CHANNEL_ID = /^[CG][A-Z0-9]{2,}$/
app.use('*', bodyLimit({ maxSize: 64 * 1024 }))

const statusResponse = (c: Context) => {
  try {
    return c.json(getSlackStatus())
  } catch {
    return c.json({ error: 'Slack status is unavailable' }, 500)
  }
}

app.get('/status', statusResponse)

app.put('/credentials', async (c) => {
  const body: unknown = await c.req.json().catch(() => undefined)
  if (body === undefined) return c.json({ error: 'Invalid JSON body' }, 400)
  try {
    saveSlackCredentials(body)
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    if (['Invalid Slack bot token', 'Invalid Slack app token'].includes(message)) return c.json({ error: message }, 400)
    return c.json({ error: 'Cannot save the Slack credentials' }, 500)
  }
  await restartSlack().catch(() => undefined)
  return statusResponse(c)
})

app.get('/channels', async (c) => {
  try {
    return c.json({ channels: await listSlackChannels() })
  } catch {
    return c.json({ error: 'Slack is not connected' }, 503)
  }
})

app.put('/workspaces/:id/channel', async (c) => {
  const body = await c.req.json<{ channelId?: unknown }>().catch(() => null)
  const raw = body?.channelId
  const channelId = raw === null ? null : typeof raw === 'string' ? raw.trim() : undefined
  if (!body || channelId === undefined || (channelId !== null && !SLACK_CHANNEL_ID.test(channelId)))
    return c.json({ error: 'Invalid Slack channel ID' }, 400)
  try {
    await linkSlackChannel(c.req.param('id'), channelId)
    return c.json({ slackChannelId: channelId })
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    if (/^Workspace '.*' not found$/.test(message)) return c.json({ error: message }, 404)
    if (message === 'Slack channel is already linked to another workspace') return c.json({ error: message }, 409)
    if (err instanceof WorkspaceLifecycleBusyError) return c.json({ error: err.message }, 409)
    return c.json({ error: 'Cannot link the Slack channel' }, 500)
  }
})

app.put('/workspaces/:id/question-mirror', async (c) => {
  const body = await c.req.json<{ mode?: unknown }>().catch(() => null)
  const mode = body?.mode
  if (!isSlackQuestionMirror(mode)) return c.json({ error: 'Invalid question mirror mode' }, 400)
  try {
    await setSlackQuestionMirror(c.req.param('id'), mode)
    return c.json({ slackQuestionMirror: mode })
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    if (/^Workspace '.*' not found$/.test(message)) return c.json({ error: message }, 404)
    if (err instanceof WorkspaceLifecycleBusyError) return c.json({ error: err.message }, 409)
    return c.json({ error: 'Cannot save the question mirror mode' }, 500)
  }
})

export default app
