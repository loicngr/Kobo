import {
  type CanUseTool,
  type McpStdioServerConfig,
  type Options,
  type PermissionResult,
  query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { nanoid } from 'nanoid'
import { isWorkspacePermissionAllowed } from '../../../workspace-permission-policy-service.js'
import { createStreamingBatcher } from '../../streaming-batcher.js'
import { createTurnLiveness } from '../../turn-liveness.js'
import {
  AGENT_NO_LONGER_RUNNING_TEXT,
  type AgentEngine,
  type AgentEvent,
  type EngineProcess,
  type StartOptions,
} from '../types.js'
import { CLAUDE_CODE_CAPABILITIES } from './capabilities.js'
import { createMapperState, mapSdkMessage, QUOTA_PATTERN, tryEmitQuota } from './event-mapper.js'
import { buildClaudeOptions } from './options-builder.js'
import { buildCompactionSessionStartOutput } from './precompact-hook.js'
import { resolveClaudeBinaryPath } from './resolve-binary.js'
import { buildStopHookOutput } from './stop-hook.js'

type McpStdioServerConfigWithAlwaysLoad = McpStdioServerConfig & { alwaysLoad: boolean }

/**
 * Grace window between the SDK's terminal `result` message and the generator
 * reaching `done`. A healthy run closes within milliseconds; if the generator
 * stays parked past this (a hung subagent task or stuck MCP/teardown), the
 * post-result drain watchdog force-emits `session:ended` so the orchestrator
 * and auto-loop are not frozen forever.
 */
const RESULT_DRAIN_TIMEOUT_MS = 15_000
/**
 * Deadline for a stream that stops reporting ANY activity. The former
 * text-only guard was re-armed solely on a message with text and no tool call
 * — the minority shape — so a run frozen mid-tool-call had no timer at all,
 * `isAlive()` kept answering true, and the workspace stayed `executing`
 * forever with zero trace. Exported so tests never hard-code the value.
 */
export const CLAUDE_STREAM_IDLE_TIMEOUT_MS = 120_000
// Safety net for a subagent whose terminal `task_notification` carries a
// status outside the mapper's known-terminal set (SDK schema drift) — it
// never clears `activeSubagentToolCallIds`, which otherwise blocks
// `inputStream.close()`/the result-drain watchdog forever. Generous window:
// legitimate subagents can run for several minutes.
const SUBAGENT_STALL_TIMEOUT_MS = 10 * 60_000
const MAX_PENDING_USER_MESSAGES = 20

function toMcpServersMap(specs: StartOptions['mcpServers']): Options['mcpServers'] | undefined {
  if (!specs || specs.length === 0) return undefined
  const map: Record<string, McpStdioServerConfigWithAlwaysLoad> = {}
  for (const s of specs) {
    // `alwaysLoad: true` is required: without it, MCP tools sit behind the
    // SDK's ToolSearch indirection that — even under bypassPermissions —
    // surfaces a "haven't granted it yet" gate. With it, MCP tools behave
    // like built-ins, matching pre-SDK CLI behaviour.
    map[s.name] = { type: 'stdio', command: s.command, args: s.args, env: s.env, alwaysLoad: true }
  }
  return map
}

interface PendingResolver {
  resolve: (result: PermissionResult) => void
  /** The original input the SDK passed to canUseTool — used to echo back questions on resolve. */
  input: Record<string, unknown>
  requestKind: 'question' | 'permission'
}

class ClaudeInputStream implements AsyncIterable<SDKUserMessage> {
  private readonly messages: Array<{ message: SDKUserMessage; forced: boolean }>
  private waiting?: () => void
  private closed = false
  private queuedForcedMessages = 0
  private yieldedMessages = 0

  constructor(initialPrompt: string) {
    this.messages = [{ message: this.toUserMessage(initialPrompt), forced: false }]
  }

  send(text: string): void {
    if (this.closed) throw new Error('Claude input stream is closed')
    if (this.queuedForcedMessages >= MAX_PENDING_USER_MESSAGES) {
      throw new Error(`Claude input queue is full (max ${MAX_PENDING_USER_MESSAGES} messages)`)
    }
    this.messages.push({ message: this.toUserMessage(text), forced: true })
    this.queuedForcedMessages++
    const wake = this.waiting
    this.waiting = undefined
    wake?.()
  }

  close(): void {
    this.closed = true
    const wake = this.waiting
    this.waiting = undefined
    wake?.()
  }

  hasUnansweredInput(completedResponses: number): boolean {
    return this.queuedForcedMessages > 0 || this.yieldedMessages > completedResponses
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage, void, undefined> {
    while (!this.closed || this.messages.length > 0) {
      const next = this.messages.shift()
      if (next) {
        if (next.forced) this.queuedForcedMessages--
        this.yieldedMessages++
        yield next.message
        continue
      }
      await new Promise<void>((resolve) => {
        this.waiting = resolve
      })
    }
  }

  private toUserMessage(text: string): SDKUserMessage {
    return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
  }
}

export function createClaudeCodeEngine(): AgentEngine {
  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    capabilities: CLAUDE_CODE_CAPABILITIES,
    async start(options: StartOptions, onEvent): Promise<EngineProcess> {
      const abortController = new AbortController()
      const mapperState = createMapperState()
      // UI/tool ids can differ from the SDK task id. Key by the stable UI id
      // so a terminal notification that omits task_id still clears the task.
      const activeSubagentTaskIds = new Map<string, string>()

      // Pending canUseTool callbacks, keyed by SDK ctx.toolUseID.
      const pendingResolvers = new Map<string, PendingResolver>()

      const isInteractive = options.agentPermissionMode === 'interactive'

      const canUseTool: CanUseTool = (toolName, input, ctx) => {
        const toolCallId =
          typeof ctx.toolUseID === 'string' && ctx.toolUseID.length > 0 ? ctx.toolUseID : `tu_${nanoid()}`

        // Non-interactive modes: the SDK has already applied its permissionMode
        // rules before reaching us, so allow through unchanged. AskUserQuestion
        // is the exception — it always defers to the user.
        if (toolName !== 'AskUserQuestion' && !isInteractive) {
          return Promise.resolve<PermissionResult>({ behavior: 'allow', updatedInput: input })
        }
        if (
          toolName !== 'AskUserQuestion' &&
          isWorkspacePermissionAllowed(options.workspaceId, { engine: 'claude-code', toolName, payload: input })
        ) {
          return Promise.resolve<PermissionResult>({ behavior: 'allow', updatedInput: input })
        }

        const requestKind: 'question' | 'permission' = toolName === 'AskUserQuestion' ? 'question' : 'permission'

        return new Promise<PermissionResult>((resolve, reject) => {
          const resolver: PendingResolver = { resolve, input, requestKind }
          pendingResolvers.set(toolCallId, resolver)
          // A user decision is intentional inactivity — suspend the deadline
          // rather than cancel it, so it resumes the moment the card is answered.
          turnLiveness.pause()

          const onAbort = (): void => {
            if (pendingResolvers.get(toolCallId) === resolver) {
              pendingResolvers.delete(toolCallId)
              const abortError = new Error('Pending user input aborted')
              abortError.name = 'AbortError'
              reject(abortError)
            }
          }
          if (ctx.signal.aborted) {
            onAbort()
            return
          }
          ctx.signal.addEventListener('abort', onAbort, { once: true })

          onEvent({
            kind: 'session:user-input-requested',
            requestKind,
            toolCallId,
            toolName,
            payload: input,
          })
        })
      }

      // Re-inject the workspace's task/criteria reminder after a compaction.
      // The current Claude Code hook schema dropped PreCompact's
      // hookSpecificOutput, so the old `{ hookEventName: 'PreCompact', … }`
      // return is rejected at runtime with a ZodError. We use SessionStart
      // instead — it fires with `source: 'compact'` after compaction and does
      // support `additionalContext`. `buildCompactionSessionStartOutput` gates
      // on the compact source so normal startup/resume/clear inject nothing.
      const hooks: Options['hooks'] = {
        SessionStart: [
          {
            hooks: [
              async (input) => {
                const source = (input as { source?: string }).source ?? ''
                return buildCompactionSessionStartOutput(options.workspaceId, source)
              },
            ],
          },
        ],
        // Decision-point enforcement of the "schedule a wakeup or the session
        // stalls" invariant: when the agent tries to end its turn with
        // background work still in flight and nothing scheduled to resume the
        // session, inject a reminder so it calls `kobo__schedule_wakeup` instead
        // of going idle. A passive system-prompt rule isn't enough — see
        // stop-hook.ts. `additionalContext` continues the turn so the model acts.
        Stop: [
          {
            hooks: [
              async (input) =>
                buildStopHookOutput(options.workspaceId, input as Parameters<typeof buildStopHookOutput>[1]),
            ],
          },
        ],
      }

      const { options: sdkOptions, effectivePrompt } = buildClaudeOptions({
        prompt: options.prompt,
        model: options.model,
        effort: options.effort,
        agentPermissionMode: options.agentPermissionMode ?? 'bypass',
        resumeFromEngineSessionId: options.resumeFromEngineSessionId,
        workingDir: options.workingDir,
        mcpServers: toMcpServersMap(options.mcpServers),
        hooks,
        canUseTool,
        stderr: (data: string) => {
          // QUOTA_PATTERN covers the canonical surfaces (rate_limit,
          // out of extra usage, usage limit, quota exceeded). The 429+rate
          // combo is a CLI-only HTTP-level surface that the SDK never emits
          // structurally, so it stays as a separate guard alongside.
          const lower = data.toLowerCase()
          const isQuota = QUOTA_PATTERN.test(data) || (lower.includes('429') && lower.includes('rate'))
          if (isQuota) {
            // Share `mapperState.quotaErrorEmitted` with the SDK iterator so
            // a single run that surfaces quota via BOTH stderr AND a
            // structured SDK signal (assistant.error / rate_limit_event)
            // does not double-fire `handleQuota` (which would double the
            // retryCount and overwrite the persisted backoff row).
            tryEmitQuota(mapperState, onEvent, data)
          } else if (lower.includes('no conversation found with session id')) {
            onEvent({ kind: 'error', category: 'resume_failed', message: data })
          } else if (data.trim().length > 0) {
            console.warn(`[claude-engine stderr] ${data}`)
          }
        },
        env: options.env,
      })
      sdkOptions.abortController = abortController

      // Override the SDK's libc-blind binary resolution on Linux glibc — see
      // resolve-binary.ts for the full rationale. No-op on macOS/Windows/musl.
      const explicitBinary = resolveClaudeBinaryPath()
      if (explicitBinary) sdkOptions.pathToClaudeCodeExecutable = explicitBinary

      const inputStream = new ClaudeInputStream(effectivePrompt)
      const q = query({ prompt: inputStream, options: sdkOptions })

      let discoveredSessionId: string | undefined

      // A throwing onEvent handler (e.g. DB query against a closed connection
      // during async test teardown) must not escape as an unhandled rejection.
      const emitDirect = (ev: AgentEvent): void => {
        try {
          onEvent(ev)
        } catch (err) {
          console.error('[claude-engine] onEvent handler threw:', err)
        }
      }
      const streamingBatcher = createStreamingBatcher(emitDirect)
      const safeEmit = (ev: AgentEvent): void => streamingBatcher.push(ev)

      let iteratorRunning = false
      let userInterrupted = false
      let completedResponses = 0
      let turnCompletedEmittedForResponse = 0

      // `result` is the Claude Agent SDK's per-turn completion signal. Keep
      // it distinct from iterator completion: the SDK may still drain
      // informational events afterwards, while Kōbō must retain the session
      // for orchestration and auto-loop until `session:ended`.
      const emitTurnCompletedIfSettled = (): void => {
        if (
          completedResponses === 0 ||
          completedResponses === turnCompletedEmittedForResponse ||
          activeSubagentTaskIds.size > 0 ||
          pendingResolvers.size > 0 ||
          inputStream.hasUnansweredInput(completedResponses)
        ) {
          return
        }
        turnCompletedEmittedForResponse = completedResponses
        safeEmit({ kind: 'turn:completed' })
      }

      // Guard so the post-result drain watchdog and the natural loop exit (or
      // catch block) never both emit `session:ended` for the same run.
      let sessionEndedEmitted = false
      const emitSessionEnded = (
        reason: 'completed' | 'error' | 'killed' | 'watchdog',
        exitCode: number | null,
      ): void => {
        if (sessionEndedEmitted) return
        sessionEndedEmitted = true
        safeEmit({ kind: 'session:ended', reason, exitCode })
      }

      // Post-result drain watchdog. The SDK emits a terminal `result` message
      // when the turn completes; the generator should then reach `done`
      // near-instantly. If it stays parked (a hung subagent task or stuck
      // teardown), the `for await` below would wait forever — `session:ended`
      // would never fire, freezing the orchestrator and the auto-loop. Once a
      // `result` is observed with no background subagent still running, we arm
      // a timer that force-emits `session:ended` with the result's own outcome,
      // then aborts the generator best-effort. A result emitted while a
      // background subagent is active is not terminal: the SDK can still emit
      // its task notification and an automatic continuation turn.
      let resultDrainTimer: ReturnType<typeof setTimeout> | undefined
      // D2 — one shared liveness module for both engines. Armed before the
      // first SDK message, re-armed on EVERY message, suspended while a human
      // decision or a background subagent is outstanding, stopped in `finally`.
      const turnLiveness = createTurnLiveness({
        timeoutMs: CLAUDE_STREAM_IDLE_TIMEOUT_MS,
        onTimeout() {
          console.warn(
            `[claude-engine] SDK stream reported no activity for ${CLAUDE_STREAM_IDLE_TIMEOUT_MS}ms — forcing session:ended`,
          )
          if (userInterrupted) emitSessionEnded('killed', null)
          else if (mapperState.sawErrorResult) emitSessionEnded('error', null)
          else emitSessionEnded('watchdog', null)
          abortController.abort()
        },
      })
      const armResultDrainWatchdog = (): void => {
        if (resultDrainTimer) return
        resultDrainTimer = setTimeout(() => {
          console.warn(
            `[claude-engine] SDK generator still open ${RESULT_DRAIN_TIMEOUT_MS}ms after 'result' — forcing session:ended`,
          )
          if (userInterrupted) emitSessionEnded('killed', null)
          else if (mapperState.sawErrorResult) emitSessionEnded('error', null)
          else emitSessionEnded('watchdog', null)
          abortController.abort()
        }, RESULT_DRAIN_TIMEOUT_MS)
        resultDrainTimer.unref?.()
      }

      // Safety net for the "waiting on a background subagent" branch below:
      // if `activeSubagentToolCallIds` never empties (a missed/unrecognised
      // terminal notification), the workspace would otherwise stay `executing`
      // forever. Force the drain through once this fires.
      let subagentStallTimer: ReturnType<typeof setTimeout> | undefined
      const clearSubagentStallWatchdog = (): void => {
        if (!subagentStallTimer) return
        clearTimeout(subagentStallTimer)
        subagentStallTimer = undefined
      }
      // Re-armed (not merely armed-once) on every qualifying `result` so the
      // deadline tracks the last observed activity, matching the warning
      // message below — a long chain of legitimate subagent-backed turns
      // must not be cut off just because 10 minutes have passed in total.
      const armSubagentStallWatchdog = (): void => {
        clearSubagentStallWatchdog()
        subagentStallTimer = setTimeout(() => {
          subagentStallTimer = undefined
          // A message queued between arming and firing means a new turn is
          // about to start on this same stream — don't discard the subagent
          // tracking or force-close under it; the next 'result' re-evaluates.
          if (inputStream.hasUnansweredInput(completedResponses)) return
          console.warn(
            `[claude-engine] Subagent(s) still tracked active ${SUBAGENT_STALL_TIMEOUT_MS}ms after the last turn ended — forcing session drain.`,
          )
          activeSubagentTaskIds.clear()
          // This is a forced, unclean termination (the subagent may still be
          // alive server-side) — never report it as a normal completion, so
          // auto-loop doesn't treat an orphaned run as forward progress.
          mapperState.sawErrorResult = true
          inputStream.close()
          armResultDrainWatchdog()
        }, SUBAGENT_STALL_TIMEOUT_MS)
        subagentStallTimer.unref?.()
      }

      const iteratorPromise = (async () => {
        iteratorRunning = true
        turnLiveness.start()
        try {
          for await (const msg of q as AsyncIterable<SDKMessage>) {
            const events = mapSdkMessage(msg, mapperState)
            for (const ev of events) {
              if (ev.kind !== 'subagent:progress') continue
              if (ev.status === 'running') activeSubagentTaskIds.set(ev.toolCallId, ev.taskId ?? ev.toolCallId)
              else activeSubagentTaskIds.delete(ev.toolCallId)
            }
            // The stall watchdog is only armed while we're waiting purely on
            // background subagents (no further SDK turn expected unless one
            // reports done). React the moment the last one clears instead of
            // waiting for a 'result' message that may never come.
            if (
              subagentStallTimer &&
              activeSubagentTaskIds.size === 0 &&
              !inputStream.hasUnansweredInput(completedResponses)
            ) {
              clearSubagentStallWatchdog()
              inputStream.close()
              armResultDrainWatchdog()
            }
            for (const ev of events) {
              if (ev.kind === 'session:started') discoveredSessionId = ev.engineSessionId
              safeEmit(ev)
            }
            // Any SDK message is proof of life — re-arm on EVERY message, not
            // only on a text-without-tool-call one.
            turnLiveness.activity()
            // A background subagent or a pending permission card can stay
            // legitimately quiet for minutes; their own dedicated watchdogs
            // own those windows, so suspend the turn deadline meanwhile.
            if (activeSubagentTaskIds.size > 0 || pendingResolvers.size > 0) turnLiveness.pause()
            else turnLiveness.resume()
            if ((msg as { type?: string }).type === 'result') {
              completedResponses++
              emitTurnCompletedIfSettled()
              // A queued forced message starts the next response on this same SDK stream.
              if (!inputStream.hasUnansweredInput(completedResponses)) {
                if (activeSubagentTaskIds.size === 0) {
                  clearSubagentStallWatchdog()
                  inputStream.close()
                  armResultDrainWatchdog()
                } else {
                  armSubagentStallWatchdog()
                }
              }
            }
          }
          // If the SDK ended with a `result.subtype === 'error_*'`, the
          // event-mapper already surfaced an `error` event but the iterator
          // still terminated naturally. Reflect that in the session:ended
          // reason so the orchestrator transitions the workspace to `error`.
          // A user soft-interrupt also drains naturally (the SDK emits
          // `error_during_execution`, which the mapper suppresses) — report
          // it as `killed`, consistent with the catch-block abort path.
          const endReason = userInterrupted ? 'killed' : mapperState.sawErrorResult ? 'error' : 'completed'
          emitSessionEnded(endReason, endReason === 'completed' ? 0 : null)
        } catch (err) {
          // Treat any abort we triggered (stop() → abortController.abort()) as
          // a clean kill. The SDK sometimes throws a generic Error with message
          // "Claude Code process aborted by user" instead of a typed AbortError.
          const error = err as Error
          const isAbort =
            userInterrupted ||
            error.name === 'AbortError' ||
            abortController.signal.aborted ||
            /aborted by user|process aborted|abortError|ede_diagnostic/i.test(error.message ?? '')
          if (isAbort) {
            emitSessionEnded('killed', null)
          } else {
            safeEmit({
              kind: 'error',
              category: 'spawn_failed',
              message: error.message,
            })
            emitSessionEnded('error', null)
          }
        } finally {
          streamingBatcher.close()
          // The post-result drain watchdog (if armed) is moot once the
          // iterator has exited — clear it so a healthy run never triggers a
          // stray abort after it already ended.
          if (resultDrainTimer) {
            clearTimeout(resultDrainTimer)
            resultDrainTimer = undefined
          }
          turnLiveness.stop()
          clearSubagentStallWatchdog()
          // Drain any callback still pending (SDK terminated while awaiting an
          // answer). canUseTool's abort path covers signalled stops; this
          // covers natural iterator completion.
          for (const resolver of pendingResolvers.values()) {
            try {
              resolver.resolve({ behavior: 'deny', message: 'session ended', interrupt: false })
            } catch {
              // best-effort
            }
          }
          pendingResolvers.clear()
          iteratorRunning = false
          inputStream.close()
        }
      })()

      const engineProcess: EngineProcess = {
        get pid() {
          return undefined
        },
        get engineSessionId() {
          return discoveredSessionId
        },
        isAlive(): boolean {
          return iteratorRunning
        },
        sendMessage(text: string) {
          if (!iteratorRunning) throw new Error(`Claude ${AGENT_NO_LONGER_RUNNING_TEXT}`)
          inputStream.send(text)
        },
        interrupt() {
          userInterrupted = true
          // The SDK ends an interrupted run by emitting a `result` with
          // subtype `error_during_execution` through the normal iterator —
          // the mapper needs this flag to treat it as a clean stop.
          mapperState.userInterrupted = true
          // The soft interrupt below only ends the foreground turn — a
          // background subagent task keeps running unless told to stop via
          // its own API, which would otherwise leave the Stop button
          // appearing to do nothing for up to SUBAGENT_STALL_TIMEOUT_MS.
          for (const taskId of activeSubagentTaskIds.values()) {
            try {
              void q.stopTask(taskId).catch(() => {
                /* best-effort */
              })
            } catch {
              /* best-effort */
            }
          }
          const qq = q as unknown as { interrupt?: () => unknown }
          if (typeof qq.interrupt === 'function') {
            try {
              const r = qq.interrupt()
              if (r && typeof (r as Promise<unknown>).catch === 'function') {
                ;(r as Promise<unknown>).catch(() => {
                  /* ignore */
                })
              }
            } catch {
              abortController.abort()
            }
          } else {
            abortController.abort()
          }
        },
        async stop() {
          abortController.abort()
          try {
            await iteratorPromise
          } catch {
            // swallow — best effort
          }
        },
        resolvePendingUserInput(toolCallId, response): boolean {
          const resolver = pendingResolvers.get(toolCallId)
          if (!resolver) return false
          pendingResolvers.delete(toolCallId)
          // Only resume the deadline once every outstanding card is answered —
          // a sibling request may still be waiting on a human.
          if (pendingResolvers.size === 0) turnLiveness.resume()

          if (response.kind === 'question') {
            // Echo the original questions array + answers so the SDK
            // reconstructs the AskUserQuestion tool input.
            const original = resolver.input
            const questions = (original as { questions?: unknown }).questions
            resolver.resolve({
              behavior: 'allow',
              updatedInput: {
                ...(typeof questions !== 'undefined' ? { questions } : {}),
                answers: response.answers,
                ...(response.response !== undefined ? { response: response.response } : {}),
              },
            })
            return true
          }
          if (response.kind === 'question-cancel') {
            // Deny so the agent gets an error tool_result and can adapt.
            resolver.resolve({
              behavior: 'deny',
              message: response.reason ?? 'User cancelled the question',
              interrupt: false,
            })
            return true
          }
          if (response.kind === 'permission-allow') {
            resolver.resolve({ behavior: 'allow', updatedInput: resolver.input })
            return true
          }
          // permission-deny
          resolver.resolve({
            behavior: 'deny',
            message: response.reason ?? 'denied by user',
            interrupt: false,
          })
          return true
        },
      }
      return engineProcess
    },
  }
}
