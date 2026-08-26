import { getPackageVersion } from '../../../../utils/paths.js'
import { isWorkspacePermissionAllowed } from '../../../workspace-permission-policy-service.js'
import { createStreamingBatcher } from '../../streaming-batcher.js'
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
import { createTurnLiveness } from './turn-liveness.js'

/** Long enough for normal tool work, short enough to recover a lost turn event. */
export const CODEX_TURN_IDLE_TIMEOUT_MS = 120_000
export const CODEX_GRACEFUL_INTERRUPT_TIMEOUT_MS = 3_000
// Safety net while `turnLiveness` is paused for background subagents: that
// pause is deliberately unbounded (a legitimate subagent can run long), but
// if a thread never reports a terminal status (dropped notification, or the
// sub-thread's own process hanging), nothing else would ever resume it or
// resolve `turnDonePromise` — the session would hang forever. Generous
// window, refreshed on every observed subagent-thread status change.
export const CODEX_SUBAGENT_STALL_TIMEOUT_MS = 10 * 60_000

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class CodexTurnTimeoutError extends Error {
  constructor() {
    super('Codex stopped reporting activity for this turn')
    this.name = 'CodexTurnTimeoutError'
  }
}

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
      let activeTurnId: string | undefined
      let steerChain: Promise<void> = Promise.resolve()
      let gracefulInterruptPromise: Promise<void> | undefined
      let readySettled = false
      let resolveReady!: () => void
      let rejectReady!: (error: Error) => void
      const readyPromise = new Promise<void>((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
      })
      void readyPromise.catch(() => {})

      const emitDirect = (ev: AgentEvent): void => {
        try {
          onEvent(ev)
        } catch (err) {
          console.error('[codex-engine] onEvent handler threw:', err)
        }
      }
      const streamingBatcher = createStreamingBatcher(emitDirect)
      const safeEmit = (ev: AgentEvent): void => streamingBatcher.push(ev)

      let rejectChildFailure!: (error: Error) => void
      const childFailurePromise = new Promise<never>((_resolve, reject) => {
        rejectChildFailure = reject
      })
      void childFailurePromise.catch(() => {})

      const child = spawnAppServer({ cwd: options.workingDir, env: options.env, signal: abortController.signal })

      child.on('error', (error: NodeJS.ErrnoException) => {
        const isExpectedAbort =
          abortController.signal.aborted && (error.code === 'ABORT_ERR' || error.name === 'AbortError')
        if (isExpectedAbort) return
        console.error('[codex] child process error:', error)
        rejectChildFailure(error)
      })
      child.once('exit', (code, signal) => {
        if (!iteratorRunning || abortController.signal.aborted) return
        const detail = code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`
        rejectChildFailure(new Error(`Codex app-server exited unexpectedly with ${detail}`))
      })

      const waitForChild = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, childFailurePromise])

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
      const activeSubagentThreads = new Map<string, { toolCallId: string; description?: string; taskType?: string }>()
      let waitingForBackgroundSubagents = false
      const turnDonePromise = new Promise<void>((resolve, reject) => {
        resolveTurnDone = resolve
        rejectTurnDone = reject
      })
      let subagentStallTimer: ReturnType<typeof setTimeout> | undefined
      const clearSubagentStallWatchdog = (): void => {
        if (!subagentStallTimer) return
        clearTimeout(subagentStallTimer)
        subagentStallTimer = undefined
      }
      // Re-armed on every observed subagent-thread status change so the
      // deadline tracks the last activity, not the start of the wait.
      const armSubagentStallWatchdog = (): void => {
        clearSubagentStallWatchdog()
        subagentStallTimer = setTimeout(() => {
          subagentStallTimer = undefined
          console.warn(
            `[codex-engine] Background subagent thread(s) still tracked active ${CODEX_SUBAGENT_STALL_TIMEOUT_MS}ms after the turn completed — forcing session drain.`,
          )
          activeSubagentThreads.clear()
          // Forced, unclean termination (a thread may still be alive
          // server-side) — never report it as a normal completion, so
          // auto-loop doesn't treat an orphaned run as forward progress.
          mapperState.sawErrorResult = true
          if (waitingForBackgroundSubagents) resolveTurnDone()
        }, CODEX_SUBAGENT_STALL_TIMEOUT_MS)
        subagentStallTimer.unref?.()
      }
      const finishBackgroundSubagent = (threadId: string, alreadyEmittedToolCallId?: string): void => {
        const tracked = activeSubagentThreads.get(threadId)
        if (!tracked) return
        activeSubagentThreads.delete(threadId)
        if (tracked.toolCallId !== alreadyEmittedToolCallId) {
          safeEmit({
            kind: 'subagent:progress',
            toolCallId: tracked.toolCallId,
            status: 'done',
            description: tracked.description,
            taskType: tracked.taskType,
          })
        }
        if (waitingForBackgroundSubagents) {
          if (activeSubagentThreads.size === 0) {
            clearSubagentStallWatchdog()
            resolveTurnDone()
          } else {
            armSubagentStallWatchdog()
          }
        }
      }
      const turnLiveness = createTurnLiveness({
        timeoutMs: CODEX_TURN_IDLE_TIMEOUT_MS,
        onTimeout() {
          mapperState.sawErrorResult = true
          safeEmit({ kind: 'error', category: 'other', message: 'Codex stopped reporting activity for this turn' })
          rejectTurnDone(new CodexTurnTimeoutError())
        },
      })
      void turnDonePromise.catch(() => {})
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
          turnLiveness.activity()
          // Ignored notifications — harmless bookkeeping by the server
          if (method === 'mcpServer/startupStatus/updated') {
            const status = (params ?? {}) as Record<string, unknown>
            const rawStatus = String(status.status ?? status.state ?? 'starting').toLowerCase()
            const normalized =
              rawStatus.includes('error') || rawStatus.includes('fail')
                ? 'error'
                : rawStatus.includes('ready') || rawStatus.includes('running')
                  ? 'ready'
                  : 'starting'
            const serverName = String(status.serverName ?? status.name ?? status.id ?? 'MCP')
            const rawMessage = typeof status.message === 'string' ? status.message : undefined
            const message = rawMessage?.replace(/(token|api[_-]?key|secret)\s*[:=]\s*\S+/gi, '$1=[redacted]')
            safeEmit({ kind: 'mcp:status', serverName, status: normalized, message })
            return
          }
          if (method === 'thread/status/changed') {
            const notification = params as { threadId?: string; status?: { type?: string } }
            if (notification.threadId && notification.status?.type !== 'active') {
              finishBackgroundSubagent(notification.threadId)
            }
            return
          }
          if (method === 'thread/started' || method === 'remoteControl/status/changed' || method === 'turn/started') {
            return
          }

          if (method === 'item/started') {
            const n = params as ItemStartedNotification
            const events = handleItemStarted(n.item, mapperState)
            for (const ev of events) safeEmit(ev)
            if (n.item.type === 'collabAgentToolCall' && n.item.tool === 'spawnAgent') {
              const progress = events.find(
                (event): event is Extract<AgentEvent, { kind: 'subagent:progress' }> =>
                  event.kind === 'subagent:progress',
              )
              if (progress) {
                for (const threadId of n.item.receiverThreadIds) {
                  activeSubagentThreads.set(threadId, {
                    toolCallId: progress.toolCallId,
                    description: progress.description,
                    taskType: progress.taskType,
                  })
                }
              }
            }
            return
          }

          if (method === 'item/completed') {
            const n = params as ItemCompletedNotification
            const events = handleItemCompleted(n.item, mapperState)
            for (const ev of events) safeEmit(ev)
            if (n.item.type === 'collabAgentToolCall') {
              const progress = events.find(
                (event): event is Extract<AgentEvent, { kind: 'subagent:progress' }> =>
                  event.kind === 'subagent:progress',
              )
              for (const [threadId, agentState] of Object.entries(n.item.agentsStates)) {
                if (agentState.status === 'pendingInit' || agentState.status === 'running') {
                  if (progress) {
                    activeSubagentThreads.set(threadId, {
                      toolCallId: progress.toolCallId,
                      description: progress.description,
                      taskType: progress.taskType,
                    })
                  }
                } else {
                  finishBackgroundSubagent(threadId, progress?.status === 'done' ? progress.toolCallId : undefined)
                }
              }
            }
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
            if (!activeTurnId || !n.turn?.id || n.turn.id === activeTurnId) {
              if (n.turn?.status === 'completed' && activeSubagentThreads.size > 0) {
                waitingForBackgroundSubagents = true
                turnLiveness.pause()
                armSubagentStallWatchdog()
              } else {
                resolveTurnDone()
              }
            }
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
              turnLiveness.pause()
            },
            respondError: (reqId, code, message) => client.peer.respondError(reqId, code, message),
            respond: (reqId, result) => client.peer.respond(reqId, result),
            autoApprove: (toolName, payload) =>
              isWorkspacePermissionAllowed(options.workspaceId, { engine: 'codex', toolName, payload }),
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
          await waitForChild(client.connect())

          if (isResume && options.resumeFromEngineSessionId) {
            await waitForChild(
              client.resumeThread({
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
              }),
            )
          } else {
            const startResp = await waitForChild(client.startThread(threadParams))
            discoveredSessionId = startResp.thread.id
          }

          for (const ev of emitSessionStarted(discoveredSessionId!, mapperState)) safeEmit(ev)

          // collaborationMode is sticky server-side — always send it explicitly,
          // never omit (would leave a Bypass turn stuck in a previous Plan mode).
          const initialTurn = await waitForChild(
            client.startTurn({
              threadId: discoveredSessionId!,
              input,
              collaborationMode,
            }),
          )
          activeTurnId = initialTurn.turnId
          turnLiveness.start()
          readySettled = true
          resolveReady()

          await waitForChild(turnDonePromise)
          turnLiveness.stop()

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
          turnLiveness.stop()
          const error = err as Error
          const message = error.message ?? String(err)
          if (!readySettled) {
            readySettled = true
            rejectReady(error)
          }
          const isAbort = userInterrupted || error.name === 'AbortError' || abortController.signal.aborted
          const isResumeAttempt = options.resumeFromEngineSessionId !== undefined

          if (isAbort) {
            safeEmit({ kind: 'session:ended', reason: 'killed', exitCode: null })
          } else if (error.name === 'CodexTurnTimeoutError') {
            safeEmit({ kind: 'session:ended', reason: 'error', exitCode: null })
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
          turnLiveness.stop()
          clearSubagentStallWatchdog()
          streamingBatcher.close()
          iteratorRunning = false
          // Drain any outstanding approval/elicitation request (SDK terminated
          // while awaiting a human decision) — without a response, Codex's own
          // process would otherwise wait forever for a reply that never comes.
          for (const pending of pendingByCallId.values()) {
            try {
              client.peer.respondError(pending.requestId, -32000, 'session ended')
            } catch {
              // best-effort
            }
          }
          pendingByCallId.clear()
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
        sendMessage(text: string): Promise<void> {
          const steer = async (): Promise<void> => {
            await readyPromise
            if (!discoveredSessionId || !activeTurnId) {
              throw new Error('Codex session is not ready to receive a message')
            }
            const response = await client.steerTurn({
              threadId: discoveredSessionId,
              expectedTurnId: activeTurnId,
              input: [{ type: 'text', text, text_elements: [] }],
            })
            activeTurnId = response.turnId
          }
          const queued = steerChain.then(steer)
          steerChain = queued.catch(() => {})
          return queued
        },
        interrupt() {
          userInterrupted = true
          if (gracefulInterruptPromise) return
          gracefulInterruptPromise = (async () => {
            if (discoveredSessionId) {
              await Promise.race([
                client.interruptTurn({ threadId: discoveredSessionId }).catch(() => {}),
                wait(CODEX_GRACEFUL_INTERRUPT_TIMEOUT_MS),
              ])
            }
            await Promise.race([turnDonePromise.catch(() => {}), wait(CODEX_GRACEFUL_INTERRUPT_TIMEOUT_MS)])
            if (iteratorRunning) abortController.abort()
          })()
        },
        async stop() {
          engineProcess.interrupt()
          await gracefulInterruptPromise
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
          // Only resume the idle-timeout clock once every outstanding
          // approval has been answered — a sibling request may still be
          // waiting on a human decision.
          if (pendingByCallId.size === 0) turnLiveness.resume()
          const result = buildResponseForResolve(pending, response)
          client.peer.respond(pending.requestId, result)
          return true
        },
      }

      return engineProcess
    },
  }
}
