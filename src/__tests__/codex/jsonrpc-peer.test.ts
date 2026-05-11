import { Readable, Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createJsonRpcPeer } from '../../server/services/agent/engines/codex/jsonrpc/peer.js'

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

describe('createJsonRpcPeer', () => {
  it('returns a fulfilled promise when the matching response arrives', async () => {
    const { stdin, stdout, written } = makeStreams()
    const peer = createJsonRpcPeer({ stdin, stdout, onNotification: () => {}, onServerRequest: () => {} })
    const p = peer.request('thread/start', { cwd: '/tmp' })
    // First written line should be a request with id=1
    expect(written[0]).toContain('"id":1')
    expect(written[0]).toContain('"method":"thread/start"')
    // Server replies
    stdout.push('{"jsonrpc":"2.0","id":1,"result":{"thread":{"id":"thr_x"}}}\n')
    await expect(p).resolves.toEqual({ thread: { id: 'thr_x' } })
  })

  it('dispatches notifications to onNotification', async () => {
    const { stdin, stdout } = makeStreams()
    const onNotification = vi.fn()
    createJsonRpcPeer({ stdin, stdout, onNotification, onServerRequest: () => {} })
    stdout.push('{"jsonrpc":"2.0","method":"item/completed","params":{"item":{"id":"x"}}}\n')
    await new Promise((r) => setTimeout(r, 5))
    expect(onNotification).toHaveBeenCalledWith('item/completed', { item: { id: 'x' } })
  })

  it('dispatches server-initiated requests to onServerRequest', async () => {
    const { stdin, stdout } = makeStreams()
    const onServerRequest = vi.fn()
    createJsonRpcPeer({ stdin, stdout, onNotification: () => {}, onServerRequest })
    stdout.push('{"jsonrpc":"2.0","id":42,"method":"requestUserInput","params":{"questions":[]}}\n')
    await new Promise((r) => setTimeout(r, 5))
    expect(onServerRequest).toHaveBeenCalledWith(42, 'requestUserInput', { questions: [] })
  })

  it('rejects the pending promise when an error response arrives', async () => {
    const { stdin, stdout } = makeStreams()
    const peer = createJsonRpcPeer({ stdin, stdout, onNotification: () => {}, onServerRequest: () => {} })
    const p = peer.request('thread/start', {})
    stdout.push('{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"internal"}}\n')
    await expect(p).rejects.toThrow(/JSON-RPC error -32603: internal/)
  })

  it('rejects all pending requests on close()', async () => {
    const { stdin, stdout } = makeStreams()
    const peer = createJsonRpcPeer({ stdin, stdout, onNotification: () => {}, onServerRequest: () => {} })
    const p1 = peer.request('a').catch((e) => e.message)
    const p2 = peer.request('b').catch((e) => e.message)
    peer.close()
    await expect(p1).resolves.toBe('peer closed')
    await expect(p2).resolves.toBe('peer closed')
  })
})
