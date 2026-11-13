import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSlackStore } from '../stores/slack'

const status = { configured: true, enabled: true, connected: true, botName: 'kobo', teamName: 'acme' }

function stubFetch(body: unknown, init?: ResponseInit) {
  const fetch = vi.fn(() => Promise.resolve(Response.json(body, init)))
  vi.stubGlobal('fetch', fetch)
  return fetch
}
const lastCall = (f: ReturnType<typeof stubFetch>) => {
  const [url, init] = f.mock.calls.at(-1) as unknown as [string, RequestInit | undefined]
  return { url: String(url), method: init?.method ?? 'GET', body: init?.body as string | undefined }
}

describe('slack store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('fetchStatus reads /api/slack/status', async () => {
    const f = stubFetch(status)
    const store = useSlackStore()
    await store.fetchStatus()
    expect(lastCall(f).url).toBe('/api/slack/status')
    expect(store.status).toEqual(status)
  })

  it('saveCredentials PUTs the tokens and null removes them', async () => {
    const f = stubFetch(status)
    const store = useSlackStore()
    await store.saveCredentials({ botToken: 'xoxb-1', appToken: 'xapp-1' })
    expect(lastCall(f)).toMatchObject({
      url: '/api/slack/credentials',
      method: 'PUT',
      body: JSON.stringify({ botToken: 'xoxb-1', appToken: 'xapp-1' }),
    })
    await store.saveCredentials(null)
    expect(lastCall(f).body).toBe('null')
  })

  it('fetchChannels returns channels from /api/slack/channels', async () => {
    const f = stubFetch({ channels: [{ id: 'C1', name: 'general', workspaceId: null }] })
    const store = useSlackStore()
    expect(await store.fetchChannels()).toEqual([{ id: 'C1', name: 'general', workspaceId: null }])
    expect(lastCall(f).url).toBe('/api/slack/channels')
  })

  it('linkChannel PUTs the channel for the workspace', async () => {
    const f = stubFetch({ slackChannelId: 'C1' })
    const store = useSlackStore()
    expect(await store.linkChannel('w1', 'C1')).toBe('C1')
    expect(lastCall(f)).toMatchObject({
      url: '/api/slack/workspaces/w1/channel',
      method: 'PUT',
      body: JSON.stringify({ channelId: 'C1' }),
    })
  })
})
