import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/services/slack/slack-service.js', () => ({
  getSlackStatus: vi.fn(() => ({
    configured: true,
    enabled: true,
    connected: true,
    botName: 'kobo',
    teamName: 'acme',
  })),
  restartSlack: vi.fn(async () => undefined),
  listSlackChannels: vi.fn(async () => [{ id: 'C1', name: 'general', workspaceId: null }]),
  linkSlackChannel: vi.fn(async () => undefined),
  setSlackQuestionMirror: vi.fn(async () => undefined),
}))
vi.mock('../server/services/slack/slack-credentials.js', () => ({
  saveSlackCredentials: vi.fn(),
}))

import app from '../server/routes/slack.js'
import { saveSlackCredentials } from '../server/services/slack/slack-credentials.js'
import {
  getSlackStatus,
  linkSlackChannel,
  listSlackChannels,
  restartSlack,
  setSlackQuestionMirror,
} from '../server/services/slack/slack-service.js'
import { WorkspaceLifecycleBusyError } from '../server/utils/workspace-lifecycle-guard.js'

const put = (path: string, body: unknown) =>
  app.request(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => vi.clearAllMocks())

describe('slack routes', () => {
  it('GET /status returns the status', async () => {
    const res = await app.request('/status')
    expect(res.status).toBe(200)
    expect((await res.json()).connected).toBe(true)
  })

  it('PUT /credentials saves, restarts and never echoes a token', async () => {
    const res = await put('/credentials', { botToken: 'xoxb-secret-1', appToken: 'xapp-secret-2' })
    expect(res.status).toBe(200)
    expect(saveSlackCredentials).toHaveBeenCalledWith({ botToken: 'xoxb-secret-1', appToken: 'xapp-secret-2' })
    expect(restartSlack).toHaveBeenCalled()
    const text = await res.text()
    expect(text).not.toContain('secret')
    expect(getSlackStatus).toHaveBeenCalled()
  })

  it('PUT /credentials with null deletes them', async () => {
    const res = await put('/credentials', null)
    expect(res.status).toBe(200)
    expect(saveSlackCredentials).toHaveBeenCalledWith(null)
  })

  it('PUT /credentials answers 400 with the fixed message on an invalid token', async () => {
    vi.mocked(saveSlackCredentials).mockImplementationOnce(() => {
      throw new Error('Invalid Slack bot token')
    })
    const res = await put('/credentials', { botToken: 'xoxb-leak', appToken: 'x' })
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).toContain('Invalid Slack bot token')
    expect(text).not.toContain('leak')
    expect(restartSlack).not.toHaveBeenCalled()
  })

  it('GET /channels lists channels', async () => {
    const res = await app.request('/channels')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ channels: [{ id: 'C1', name: 'general', workspaceId: null }] })
  })

  it('GET /channels answers 503 when Slack is not connected', async () => {
    vi.mocked(listSlackChannels).mockRejectedValueOnce(new Error('Slack is not connected'))
    const res = await app.request('/channels')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'Slack is not connected' })
  })

  it('PUT /workspaces/:id/channel links and unlinks', async () => {
    const res = await put('/workspaces/w1/channel', { channelId: 'C0001' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ slackChannelId: 'C0001' })
    expect(linkSlackChannel).toHaveBeenCalledWith('w1', 'C0001')
    await put('/workspaces/w1/channel', { channelId: null })
    expect(linkSlackChannel).toHaveBeenLastCalledWith('w1', null)
  })

  it('PUT /workspaces/:id/channel rejects a malformed body', async () => {
    expect((await put('/workspaces/w1/channel', { channelId: 5 })).status).toBe(400)
  })

  it('M4: PUT /workspaces/:id/channel trims the id and rejects anything but a Slack channel id', async () => {
    const res = await put('/workspaces/w1/channel', { channelId: '  C0123ABC  ' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ slackChannelId: 'C0123ABC' })
    expect(linkSlackChannel).toHaveBeenCalledWith('w1', 'C0123ABC')
    expect((await put('/workspaces/w1/channel', { channelId: 'G0456' })).status).toBe(200)
    vi.mocked(linkSlackChannel).mockClear()
    for (const channelId of ['c0123', 'U0123', 'C1', 'C01 23', 'C0123\nX', '#general', '', 'C0123-x']) {
      const bad = await put('/workspaces/w1/channel', { channelId })
      expect(bad.status).toBe(400)
      expect(await bad.json()).toEqual({ error: 'Invalid Slack channel ID' })
    }
    expect(linkSlackChannel).not.toHaveBeenCalled()
  })

  it('maps service errors: 404, 409, 500', async () => {
    vi.mocked(linkSlackChannel).mockRejectedValueOnce(new Error("Workspace 'w1' not found"))
    expect((await put('/workspaces/w1/channel', { channelId: 'C0001' })).status).toBe(404)
    vi.mocked(linkSlackChannel).mockRejectedValueOnce(new Error('Slack channel is already linked to another workspace'))
    expect((await put('/workspaces/w1/channel', { channelId: 'C0001' })).status).toBe(409)
    vi.mocked(linkSlackChannel).mockRejectedValueOnce(new Error('boom xoxb-secret'))
    const res = await put('/workspaces/w1/channel', { channelId: 'C0001' })
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('secret')
  })

  it('answers 409 when the workspace lifecycle is busy', async () => {
    vi.mocked(linkSlackChannel).mockRejectedValueOnce(new WorkspaceLifecycleBusyError())
    expect((await put('/workspaces/w1/channel', { channelId: 'C0001' })).status).toBe(409)
  })

  it('GET /status answers a generic 500 when the status cannot be read', async () => {
    vi.mocked(getSlackStatus).mockImplementationOnce(() => {
      throw new Error('boom xoxb-secret')
    })
    const res = await app.request('/status')
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Slack status is unavailable' })
  })

  it('PUT /credentials answers a generic 500 when the status read after saving fails', async () => {
    vi.mocked(getSlackStatus).mockImplementationOnce(() => {
      throw new Error('boom')
    })
    expect((await put('/credentials', null)).status).toBe(500)
  })

  it('PUT /credentials answers a generic 500 for a non-validation failure', async () => {
    vi.mocked(saveSlackCredentials).mockImplementationOnce(() => {
      throw new Error('EACCES: cannot write /home/x/xoxb-secret')
    })
    const res = await put('/credentials', { botToken: 'a', appToken: 'b' })
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).toContain('Cannot save the Slack credentials')
    expect(text).not.toContain('EACCES')
    expect(restartSlack).not.toHaveBeenCalled()
  })
})

describe('slack question mirror route', () => {
  it('saves each valid mode', async () => {
    for (const mode of ['never', 'slack-conversation', 'always']) {
      const res = await put('/workspaces/w1/question-mirror', { mode })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ slackQuestionMirror: mode })
      expect(setSlackQuestionMirror).toHaveBeenLastCalledWith('w1', mode)
    }
  })

  it('rejects anything else with 400 and maps 404 and 409', async () => {
    for (const body of [{ mode: 'sometimes' }, { mode: null }, {}, null]) {
      const res = await put('/workspaces/w1/question-mirror', body)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid question mirror mode' })
    }
    expect(setSlackQuestionMirror).not.toHaveBeenCalled()
    vi.mocked(setSlackQuestionMirror).mockRejectedValueOnce(new Error("Workspace 'w1' not found"))
    expect((await put('/workspaces/w1/question-mirror', { mode: 'always' })).status).toBe(404)
    vi.mocked(setSlackQuestionMirror).mockRejectedValueOnce(new WorkspaceLifecycleBusyError())
    expect((await put('/workspaces/w1/question-mirror', { mode: 'always' })).status).toBe(409)
    vi.mocked(setSlackQuestionMirror).mockRejectedValueOnce(new Error('boom xoxb-secret'))
    const res = await put('/workspaces/w1/question-mirror', { mode: 'always' })
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('secret')
  })
})
