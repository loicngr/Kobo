import type { Readable, Writable } from 'node:stream'
import { createJsonRpcTransport, type JsonRpcMessage } from './transport.js'

/**
 * Default per-request deadline. A live-but-mute app-server used to park a
 * request forever: the child-exit guard only watches for an exit, the turn
 * liveness probe was armed after the handshake, and the cleanup block that
 * would close the connection is never reached while a `try` awaits. The
 * session hung for good, with no trace and no event.
 */
export const DEFAULT_JSONRPC_REQUEST_TIMEOUT_MS = 120_000

export class JsonRpcTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`JSON-RPC request '${method}' timed out after ${timeoutMs}ms`)
    this.name = 'JsonRpcTimeoutError'
  }
}

export interface JsonRpcPeer {
  request<TResult = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<TResult>
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
  /** Deadline applied to every request without an explicit one. `0` disables it. */
  defaultRequestTimeoutMs?: number
}

interface PendingSlot {
  resolve: (v: unknown) => void
  reject: (err: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

export function createJsonRpcPeer(opts: JsonRpcPeerOptions): JsonRpcPeer {
  let nextId = 1
  const pending = new Map<number | string, PendingSlot>()

  /** Remove a pending slot and clear its deadline in one place. */
  const takePending = (id: number | string): PendingSlot | undefined => {
    const slot = pending.get(id)
    if (!slot) return undefined
    if (slot.timer) clearTimeout(slot.timer)
    pending.delete(id)
    return slot
  }

  const transport = createJsonRpcTransport({
    stdin: opts.stdin,
    stdout: opts.stdout,
    onError: opts.onError ?? (() => {}),
    onMessage(msg: JsonRpcMessage) {
      // Response to one of our requests
      if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
        const slot = takePending(msg.id)
        if (!slot) return
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
    request<TResult>(method: string, params?: unknown, timeoutMs?: number): Promise<TResult> {
      const id = nextId++
      const deadlineMs = timeoutMs ?? opts.defaultRequestTimeoutMs ?? DEFAULT_JSONRPC_REQUEST_TIMEOUT_MS
      return new Promise<TResult>((resolve, reject) => {
        const slot: PendingSlot = { resolve: (v) => resolve(v as TResult), reject }
        if (deadlineMs > 0) {
          slot.timer = setTimeout(() => {
            pending.delete(id)
            reject(new JsonRpcTimeoutError(method, deadlineMs))
          }, deadlineMs)
          slot.timer.unref?.()
        }
        pending.set(id, slot)
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
      for (const slot of pending.values()) {
        if (slot.timer) clearTimeout(slot.timer)
        slot.reject(err)
      }
      pending.clear()
    },
  }
}
