import { Readable, Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createJsonRpcTransport } from '../../server/services/agent/engines/codex/jsonrpc/transport.js'

describe('JsonRpcTransport', () => {
  it('emits one onMessage per newline-terminated JSON object', async () => {
    const stdin = new Writable({ write: (_chunk, _enc, cb) => cb() })
    const stdout = new Readable({ read() {} })
    const onMessage = vi.fn()
    createJsonRpcTransport({ stdin, stdout, onMessage, onError: () => {} })
    stdout.push('{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0","method":"notify"}\n')
    await new Promise((r) => setTimeout(r, 5))
    expect(onMessage).toHaveBeenCalledTimes(2)
    expect(onMessage).toHaveBeenNthCalledWith(1, { jsonrpc: '2.0', id: 1, result: {} })
    expect(onMessage).toHaveBeenNthCalledWith(2, { jsonrpc: '2.0', method: 'notify' })
  })

  it('buffers partial JSON across chunks', async () => {
    const stdin = new Writable({ write: (_c, _e, cb) => cb() })
    const stdout = new Readable({ read() {} })
    const onMessage = vi.fn()
    createJsonRpcTransport({ stdin, stdout, onMessage, onError: () => {} })
    stdout.push('{"jsonrpc":"2.0","id"')
    stdout.push(':1,"result":{}}\n')
    await new Promise((r) => setTimeout(r, 5))
    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(onMessage).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 1, result: {} })
  })

  it('reports onError for malformed JSON lines and continues', async () => {
    const stdin = new Writable({ write: (_c, _e, cb) => cb() })
    const stdout = new Readable({ read() {} })
    const onMessage = vi.fn()
    const onError = vi.fn()
    createJsonRpcTransport({ stdin, stdout, onMessage, onError })
    stdout.push('not-json\n{"jsonrpc":"2.0","id":1,"result":{}}\n')
    await new Promise((r) => setTimeout(r, 5))
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onMessage).toHaveBeenCalledTimes(1)
  })

  it('serializes outgoing messages with trailing newline', () => {
    const written: string[] = []
    const stdin = new Writable({
      write(chunk, _enc, cb) {
        written.push(chunk.toString())
        cb()
      },
    })
    const stdout = new Readable({ read() {} })
    const transport = createJsonRpcTransport({ stdin, stdout, onMessage: () => {}, onError: () => {} })
    transport.send({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} })
    expect(written).toEqual(['{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}\n'])
  })
})

it('contains asynchronous stdin errors and refuses writes after failure', async () => {
  const error = Object.assign(new Error('pipe closed'), { code: 'EPIPE' })
  const stdin = new Writable({ write: (_chunk, _enc, cb) => cb(error) })
  stdin.on('error', () => {}) // Keep a failing regression from crashing the test process.
  const stdout = new Readable({ read() {} })
  const onError = vi.fn()
  const transport = createJsonRpcTransport({ stdin, stdout, onMessage: () => {}, onError })
  transport.send({ jsonrpc: '2.0', method: 'hello' })
  await new Promise((r) => setImmediate(r))
  expect(onError).toHaveBeenCalledWith(error)
  expect(() => transport.send({ jsonrpc: '2.0', method: 'late' })).toThrow(/closed|pipe/)
  transport.close()
  transport.close()
})
