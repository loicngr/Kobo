import { getPackageVersion } from '../../../../utils/paths.js'
import type { AgentEngine, AgentEvent, EngineProcess, StartOptions } from '../types.js'
import { CODEX_CAPABILITIES } from './capabilities.js'
import { createAppServerClient } from './client.js'
import {
  createMapperState,
  emitSessionStarted,
  handleAgentMessageDelta,
  handleItemCompleted,
  handleItemStarted,
  handleRateLimitsUpdated,
  handleTurnCompleted,
  QUOTA_PATTERN,
  tryEmitQuota,
} from './event-mapper.js'
import { buildCodexOptions } from './options-builder.js'
import type {
  AgentMessageDeltaNotification,
  ErrorNotification,
  ItemCompletedNotification,
  ItemStartedNotification,
  TurnCompletedNotification,
} from './protocol/types.js'
import { buildResponseForResolve, handleServerRequest, type PendingApproval } from './server-requests.js'
import { spawnAppServer } from './spawn.js'

/**
 * Heuristic for detecting a stale/expired thread id on `thread/resume`.
 * Canonical wording isn't captured yet — when matched, the engine emits
 * `error/resume_failed` so the orchestrator can restart with a fresh thread.
 */
export const RESUME_FAILED_PATTERN =
  /(thread\b.*\bnot found|session\b.*\bnot found|no\s+(such\s+)?thread|thread.*expired|conversation\b.*\bnot found|invalid\s+thread\s+id)/i

export function createCodexEngine(): AgentEngine {
  return {
    id: 'codex',
    displayName: 'OpenAI Codex',
    capabilities: CODEX_CAPABILITIES,

    async start(options: StartOptions, onEvent: (ev: AgentEvent) => void): Promise<EngineProcess> {
      const { threadParams, input, isResume, collaborationMode } = buildCodexOptions({
        prompt: options.prompt,
        model: options.model,
        effort: options.effort,
        agentPermissionMode: options.agentPermissionMode ?? 'bypass',
        resumeFromEngineSessionId: options.resumeFromEngineSessionId,
        workingDir: options.workingDir,
        mcpServers: options.mcpServers,
      })

      const mapperState = createMapperState()
      const abortController = new AbortController()
      const pendingByCallId = new Map<string, PendingApproval>()
      let iteratorRunning = false
      let userInterrupted = false
      let discoveredSessionId: string | undefined = options.resumeFromEngineSessionId

      const safeEmit = (ev: AgentEvent): void => {
        try {
          onEvent(ev)
        } catch (err) {
          console.error('[codex-engine] onEvent handler threw:', err)
        }
      }

      const child = spawnAppServer({ cwd: options.workingDir, signal: abortController.signal })

      if (child.stderr) {
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (chunk: string) => {
          const text = chunk.toString()
          if (QUOTA_PATTERN.test(text)) {
            tryEmitQuota(mapperState, safeEmit, text.trim())
          } else {
            console.warn('[codex] stderr:', text.trimEnd())
          }
        })
      }

      let resolveTurnDone!: () => void
      let rejectTurnDone!: (err: Error) => void
      const turnDonePromise = new Promise<void>((resolve, reject) => {
        resolveTurnDone = resolve
        rejectTurnDone = reject
      })
      abortController.signal.addEventListener('abort', () => {
        const err = new Error('AbortError')
        err.name = 'AbortError'
        rejectTurnDone(err)
      })

      const client = createAppServerClient({
        stdin: child.stdin!,
        stdout: child.stdout!,
        clientInfo: { name: 'kobo', version: getPackageVersion() },

        onNotification(method: string, params: unknown) {
          // Ignored notifications — harmless bookkeeping by the server
          if (
            method === 'mcpServer/startupStatus/updated' ||
            method === 'thread/started' ||
            method === 'thread/status/changed' ||
            method === 'remoteControl/status/changed' ||
            method === 'turn/started'
          ) {
            return
          }

          if (method === 'item/started') {
            const n = params as ItemStartedNotification
            for (const ev of handleItemStarted(n.item, mapperState)) safeEmit(ev)
            return
          }

          if (method === 'item/completed') {
            const n = params as ItemCompletedNotification
            for (const ev of handleItemCompleted(n.item, mapperState)) safeEmit(ev)
            return
          }

          if (method === 'item/agentMessage/delta') {
            const n = params as AgentMessageDeltaNotification
            for (const ev of handleAgentMessageDelta(n, mapperState)) safeEmit(ev)
            return
          }

          if (method === 'turn/completed') {
            const n = params as TurnCompletedNotification
            for (const ev of handleTurnCompleted(n, mapperState)) safeEmit(ev)
            resolveTurnDone()
            return
          }

          if (method === 'thread/tokenUsage/updated') {
            const p = params as {
              tokenUsage: {
                last: {
                  inputTokens: number
                  outputTokens: number
                  reasoningOutputTokens: number
                  cachedInputTokens: number
                }
              }
            }
            if (p?.tokenUsage?.last) {
              const last = p.tokenUsage.last
              safeEmit({
                kind: 'usage',
                inputTokens: last.inputTokens,
                outputTokens: last.outputTokens + last.reasoningOutputTokens,
                cacheRead: last.cachedInputTokens,
              })
            }
            return
          }

          if (method === 'account/rateLimits/updated') {
            for (const ev of handleRateLimitsUpdated(params, mapperState)) safeEmit(ev)
            return
          }

          if (method === 'error') {
            const n = params as ErrorNotification
            const msg = n?.message ?? 'unknown error'
            if (QUOTA_PATTERN.test(msg)) {
              tryEmitQuota(mapperState, safeEmit, msg)
            } else {
              mapperState.sawErrorResult = true
              safeEmit({ kind: 'error', category: 'other', message: msg })
            }
            return
          }
        },

        onServerRequest(id: number | string, method: string, params: unknown) {
          handleServerRequest({
            requestId: id,
            method,
            params,
            emit: safeEmit,
            register(callId, pending) {
              pendingByCallId.set(callId, pending)
            },
            respondError: (reqId, code, message) => client.peer.respondError(reqId, code, message),
          })
        },

        onError(err: Error) {
          console.error('[codex] JSON-RPC transport error:', err)
          rejectTurnDone(err)
        },
      })

      const iteratorPromise = (async () => {
        iteratorRunning = true
        try {
          await client.connect()

          if (isResume && options.resumeFromEngineSessionId) {
            await client.resumeThread({
              threadId: options.resumeFromEngineSessionId,
              cwd: options.workingDir,
              persistExtendedHistory: false,
              ...(threadParams.model != null ? { model: threadParams.model } : {}),
              ...(threadParams.approvalPolicy != null ? { approvalPolicy: threadParams.approvalPolicy } : {}),
              ...(threadParams.sandbox != null ? { sandbox: threadParams.sandbox } : {}),
              ...(threadParams.modelReasoningEffort != null
                ? { modelReasoningEffort: threadParams.modelReasoningEffort }
                : {}),
              ...(threadParams.config != null ? { config: threadParams.config } : {}),
            })
          } else {
            const startResp = await client.startThread(threadParams)
            discoveredSessionId = startResp.thread.id
          }

          for (const ev of emitSessionStarted(discoveredSessionId!, mapperState)) safeEmit(ev)

          // collaborationMode is sticky server-side — always send it explicitly,
          // never omit (would leave a Bypass turn stuck in a previous Plan mode).
          await client.startTurn({
            threadId: discoveredSessionId!,
            input,
            collaborationMode,
          })

          await turnDonePromise

          const reason: 'error' | 'killed' | 'completed' = mapperState.sawErrorResult
            ? 'error'
            : mapperState.sawTurnInterrupted
              ? 'killed'
              : 'completed'
          safeEmit({
            kind: 'session:ended',
            reason,
            exitCode: reason === 'completed' ? 0 : null,
          })
        } catch (err) {
          const error = err as Error
          const message = error.message ?? String(err)
          const isAbort = userInterrupted || error.name === 'AbortError' || abortController.signal.aborted
          const isResumeAttempt = options.resumeFromEngineSessionId !== undefined

          if (isAbort) {
            safeEmit({ kind: 'session:ended', reason: 'killed', exitCode: null })
          } else if (QUOTA_PATTERN.test(message)) {
            tryEmitQuota(mapperState, safeEmit, message)
            safeEmit({ kind: 'session:ended', reason: 'error', exitCode: null })
          } else if (isResumeAttempt && RESUME_FAILED_PATTERN.test(message)) {
            safeEmit({ kind: 'error', category: 'resume_failed', message })
            safeEmit({ kind: 'session:ended', reason: 'error', exitCode: null })
          } else {
            safeEmit({ kind: 'error', category: 'spawn_failed', message })
            safeEmit({ kind: 'session:ended', reason: 'error', exitCode: null })
          }
        } finally {
          iteratorRunning = false
          client.close()
          try {
            child.kill('SIGTERM')
          } catch {
            // best-effort
          }
        }
      })()

      const engineProcess: EngineProcess = {
        get pid() {
          return child.pid
        },
        get engineSessionId() {
          return discoveredSessionId
        },
        isAlive(): boolean {
          return iteratorRunning
        },
        sendMessage() {
          throw new Error('sendMessage not supported in Codex app-server single-shot mode')
        },
        interrupt() {
          userInterrupted = true
          abortController.abort()
          if (discoveredSessionId) {
            client.interruptTurn({ threadId: discoveredSessionId }).catch(() => {})
          }
        },
        async stop() {
          abortController.abort()
          try {
            await iteratorPromise
          } catch {
            // swallow — best effort
          }
          try {
            child.stdin?.end()
          } catch {
            // swallow
          }
        },
        resolvePendingUserInput(callId: string, response): boolean {
          const pending = pendingByCallId.get(callId)
          if (!pending) return false
          pendingByCallId.delete(callId)
          const result = buildResponseForResolve(pending, response)
          client.peer.respond(pending.requestId, result)
          return true
        },
      }

      return engineProcess
    },
  }
}
