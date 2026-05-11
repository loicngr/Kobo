import type { Readable, Writable } from 'node:stream'
import { createJsonRpcTransport, type JsonRpcMessage } from './transport.js'

export interface JsonRpcPeer {
  request<TResult = unknown>(method: string, params?: unknown): Promise<TResult>
  notify(method: string, params?: unknown): void
  respond(id: number | string, result: unknown): void
  respondError(id: number | string, code: number, message: string): void
  close(): void
}

export interface JsonRpcPeerOptions {
  stdin: Writable
  stdout: Readable
  onNotification: (method: string, params: unknown) => void
  onServerRequest: (id: number | string, method: string, params: unknown) => void
  onError?: (err: Error) => void
}

export function createJsonRpcPeer(opts: JsonRpcPeerOptions): JsonRpcPeer {
  let nextId = 1
  const pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (err: Error) => void }>()

  const transport = createJsonRpcTransport({
    stdin: opts.stdin,
    stdout: opts.stdout,
    onError: opts.onError ?? (() => {}),
    onMessage(msg: JsonRpcMessage) {
      // Response to one of our requests
      if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
        const slot = pending.get(msg.id)
        if (!slot) return
        pending.delete(msg.id)
        if (msg.error) {
          slot.reject(new Error(`JSON-RPC error ${msg.error.code}: ${msg.error.message}`))
        } else {
          slot.resolve(msg.result)
        }
        return
      }
      // Server-initiated request (has id + method)
      if (msg.id != null && msg.method) {
        opts.onServerRequest(msg.id, msg.method, msg.params)
        return
      }
      // Notification (no id)
      if (msg.method) {
        opts.onNotification(msg.method, msg.params)
      }
    },
  })

  return {
    request<TResult>(method: string, params?: unknown): Promise<TResult> {
      const id = nextId++
      return new Promise<TResult>((resolve, reject) => {
        pending.set(id, { resolve: (v) => resolve(v as TResult), reject })
        transport.send({ jsonrpc: '2.0', id, method, params })
      })
    },
    notify(method, params) {
      transport.send({ jsonrpc: '2.0', method, params })
    },
    respond(id, result) {
      transport.send({ jsonrpc: '2.0', id, result })
    },
    respondError(id, code, message) {
      transport.send({ jsonrpc: '2.0', id, error: { code, message } })
    },
    close() {
      transport.close()
      const err = new Error('peer closed')
      for (const slot of pending.values()) slot.reject(err)
      pending.clear()
    },
  }
}
