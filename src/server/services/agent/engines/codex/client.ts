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
  TurnSteerParams,
  TurnSteerResponse,
} from './protocol/types.js'

/**
 * A handshake that never answers is a broken install (missing binary, expired
 * token, protocol drift), not a model thinking — fail fast and loudly.
 */
export const CODEX_HANDSHAKE_TIMEOUT_MS = 20_000

/** Thread creation/resume can touch disk and the network; give it more room. */
export const CODEX_THREAD_TIMEOUT_MS = 30_000

/** An interrupt that is not acknowledged must never block the escalation path. */
export const CODEX_INTERRUPT_TIMEOUT_MS = 10_000

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
  steerTurn(params: TurnSteerParams): Promise<TurnSteerResponse>
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
      return peer.request<InitializeResponse>('initialize', params, CODEX_HANDSHAKE_TIMEOUT_MS)
    },
    startThread(params) {
      return peer.request<ThreadStartResponse>('thread/start', params, CODEX_THREAD_TIMEOUT_MS)
    },
    resumeThread(params) {
      return peer.request<ThreadStartResponse>('thread/resume', params, CODEX_THREAD_TIMEOUT_MS)
    },
    startTurn(params) {
      // Default deadline: starting a turn is the model's own latency budget.
      return peer.request<TurnStartResponse>('turn/start', params)
    },
    steerTurn(params) {
      // Same budget. Steering requests are chained, so a request left pending
      // here used to block every later message of the workspace for good.
      return peer.request<TurnSteerResponse>('turn/steer', params)
    },
    async interruptTurn(params) {
      await peer.request<unknown>('turn/interrupt', params, CODEX_INTERRUPT_TIMEOUT_MS)
    },
    close() {
      peer.close()
    },
  }
}
