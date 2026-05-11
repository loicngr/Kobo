import { Readable, Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createAppServerClient } from '../../server/services/agent/engines/codex/client.js'

function makeStreams() {
  const written: string[] = []
  const stdin = new Writable({
    write(chunk, _e, cb) {
      written.push(chunk.toString())
      cb()
    },
  })
  const stdout = new Readable({ read() {} })
  return { stdin, stdout, written }
}

const CLIENT_INFO = { name: 'kobo-test', version: '0.0.0' }

describe('createAppServerClient', () => {
  it('connect() sends initialize and resolves with the server response', async () => {
    const { stdin, stdout, written } = makeStreams()
    const client = createAppServerClient({ stdin, stdout, clientInfo: CLIENT_INFO })
    const p = client.connect()
    // The request should have been written immediately
    expect(written).toHaveLength(1)
    const msg = JSON.parse(written[0])
    expect(msg).toMatchObject({ jsonrpc: '2.0', method: 'initialize', id: 1 })
    expect(msg.params.clientInfo).toEqual(CLIENT_INFO)
    // Must opt into experimentalApi or Codex rejects turn/start.collaborationMode
    expect(msg.params.capabilities).toEqual({ experimentalApi: true })
    // Server replies with the real wire shape
    stdout.push(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          userAgent: 'codex/1.0',
          codexHome: '/home/user/.codex',
          platformFamily: 'unix',
          platformOs: 'linux',
        },
      })}\n`,
    )
    await expect(p).resolves.toEqual({
      userAgent: 'codex/1.0',
      codexHome: '/home/user/.codex',
      platformFamily: 'unix',
      platformOs: 'linux',
    })
  })

  it('startThread() sends thread/start with the params verbatim', async () => {
    const { stdin, stdout, written } = makeStreams()
    const client = createAppServerClient({ stdin, stdout, clientInfo: CLIENT_INFO })
    const threadParams = {
      cwd: '/workspace',
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    }
    const p = client.startThread(threadParams)
    expect(written).toHaveLength(1)
    const msg = JSON.parse(written[0])
    expect(msg.method).toBe('thread/start')
    expect(msg.params).toEqual(threadParams)
    // Respond so the promise resolves cleanly
    stdout.push(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          thread: {
            id: 'thr_1',
            sessionId: 's1',
            preview: '',
            ephemeral: false,
            modelProvider: 'openai',
            createdAt: 0,
            updatedAt: 0,
          },
        },
      })}\n`,
    )
    await expect(p).resolves.toMatchObject({ thread: { id: 'thr_1' } })
  })

  it('resumeThread() sends thread/resume with the params verbatim', async () => {
    const { stdin, stdout, written } = makeStreams()
    const client = createAppServerClient({ stdin, stdout, clientInfo: CLIENT_INFO })
    const resumeParams = { threadId: 'thr_existing', persistExtendedHistory: false }
    const p = client.resumeThread(resumeParams)
    expect(written).toHaveLength(1)
    const msg = JSON.parse(written[0])
    expect(msg.method).toBe('thread/resume')
    expect(msg.params).toEqual(resumeParams)
    stdout.push(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          thread: {
            id: 'thr_existing',
            sessionId: 's2',
            preview: '',
            ephemeral: false,
            modelProvider: 'openai',
            createdAt: 0,
            updatedAt: 0,
          },
        },
      })}\n`,
    )
    await expect(p).resolves.toMatchObject({ thread: { id: 'thr_existing' } })
  })

  it('startTurn() sends turn/start with the params verbatim', async () => {
    const { stdin, stdout, written } = makeStreams()
    const client = createAppServerClient({ stdin, stdout, clientInfo: CLIENT_INFO })
    const turnParams = { threadId: 'thr_1', input: [{ type: 'text' as const, text: 'Hello' }] }
    const p = client.startTurn(turnParams)
    expect(written).toHaveLength(1)
    const msg = JSON.parse(written[0])
    expect(msg.method).toBe('turn/start')
    expect(msg.params).toEqual(turnParams)
    stdout.push(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turnId: 'turn_42' } })}\n`)
    await expect(p).resolves.toEqual({ turnId: 'turn_42' })
  })

  it('notifications are forwarded to onNotification', async () => {
    const { stdin, stdout } = makeStreams()
    const onNotification = vi.fn()
    createAppServerClient({ stdin, stdout, clientInfo: CLIENT_INFO, onNotification })
    stdout.push(
      '{"jsonrpc":"2.0","method":"item/started","params":{"item":{"id":"x","type":"agentMessage","text":"hi"},"threadId":"t","turnId":"u","startedAtMs":0}}\n',
    )
    await new Promise((r) => setTimeout(r, 5))
    expect(onNotification).toHaveBeenCalledWith(
      'item/started',
      expect.objectContaining({ item: expect.objectContaining({ id: 'x' }) }),
    )
  })

  it('server-initiated requests are forwarded to onServerRequest', async () => {
    const { stdin, stdout } = makeStreams()
    const onServerRequest = vi.fn()
    createAppServerClient({ stdin, stdout, clientInfo: CLIENT_INFO, onServerRequest })
    stdout.push(
      '{"jsonrpc":"2.0","id":99,"method":"commandExecution/requestApproval","params":{"threadId":"t","turnId":"u","itemId":"i"}}\n',
    )
    await new Promise((r) => setTimeout(r, 5))
    expect(onServerRequest).toHaveBeenCalledWith(
      99,
      'commandExecution/requestApproval',
      expect.objectContaining({ threadId: 't' }),
    )
  })
})
