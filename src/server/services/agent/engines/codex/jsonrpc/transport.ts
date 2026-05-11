import type { Readable, Writable } from 'node:stream'

export interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface JsonRpcTransport {
  send(msg: JsonRpcMessage): void
  close(): void
}

export interface JsonRpcTransportOptions {
  stdin: Writable
  stdout: Readable
  onMessage: (msg: JsonRpcMessage) => void
  onError: (err: Error) => void
}

export function createJsonRpcTransport(opts: JsonRpcTransportOptions): JsonRpcTransport {
  let buffer = ''
  opts.stdout.setEncoding?.('utf-8')
  opts.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let nl = buffer.indexOf('\n')
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf('\n')
      if (!line) continue
      try {
        const parsed = JSON.parse(line) as JsonRpcMessage
        opts.onMessage(parsed)
      } catch (err) {
        opts.onError(err instanceof Error ? err : new Error(String(err)))
      }
    }
  })
  opts.stdout.on('error', opts.onError)
  return {
    send(msg) {
      opts.stdin.write(`${JSON.stringify(msg)}\n`)
    },
    close() {
      opts.stdin.end()
    },
  }
}
