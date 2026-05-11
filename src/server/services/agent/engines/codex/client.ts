import type { Readable, Writable } from 'node:stream'
import { createJsonRpcPeer, type JsonRpcPeer } from './jsonrpc/peer.js'
import type {
  InitializeParams,
  InitializeResponse,
  ThreadResumeParams,
  ThreadStartParams,
  ThreadStartResponse,
  TurnInterruptParams,
  TurnStartParams,
  TurnStartResponse,
} from './protocol/types.js'

export interface AppServerClientOptions {
  stdin: Writable
  stdout: Readable
  clientInfo: { name: string; version: string }
  onNotification?: (method: string, params: unknown) => void
  onServerRequest?: (id: number | string, method: string, params: unknown) => void
  onError?: (err: Error) => void
}

export interface AppServerClient {
  connect(): Promise<InitializeResponse>
  startThread(params: ThreadStartParams): Promise<ThreadStartResponse>
  resumeThread(params: ThreadResumeParams): Promise<ThreadStartResponse>
  startTurn(params: TurnStartParams): Promise<TurnStartResponse>
  interruptTurn(params: TurnInterruptParams): Promise<void>
  close(): void
  readonly peer: JsonRpcPeer
}

export function createAppServerClient(opts: AppServerClientOptions): AppServerClient {
  const peer = createJsonRpcPeer({
    stdin: opts.stdin,
    stdout: opts.stdout,
    onNotification: opts.onNotification ?? (() => {}),
    onServerRequest: opts.onServerRequest ?? (() => {}),
    onError: opts.onError,
  })

  return {
    peer,
    async connect() {
      // Without experimentalApi the server rejects collaborationMode (-32600).
      const params: InitializeParams = {
        clientInfo: opts.clientInfo,
        capabilities: { experimentalApi: true },
      }
      return peer.request<InitializeResponse>('initialize', params)
    },
    startThread(params) {
      return peer.request<ThreadStartResponse>('thread/start', params)
    },
    resumeThread(params) {
      return peer.request<ThreadStartResponse>('thread/resume', params)
    },
    startTurn(params) {
      return peer.request<TurnStartResponse>('turn/start', params)
    },
    async interruptTurn(params) {
      await peer.request<unknown>('turn/interrupt', params)
    },
    close() {
      peer.close()
    },
  }
}
