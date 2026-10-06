import { randomUUID } from 'node:crypto'
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
import { isSubagentTask } from '../../../../../shared/subagent-classification.js'
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
export const RESULT_DRAIN_TIMEOUT_MS = 15_000
/**
 * Deadline for a stream that stops reporting ANY activity. The former
 * text-only guard was re-armed solely on a message with text and no tool call
 * — the minority shape — so a run frozen mid-tool-call had no timer at all,
 * `isAlive()` kept answering true, and the workspace stayed `executing`
 * forever with zero trace. Exported so tests never hard-code the value.
 */
export const CLAUDE_STREAM_IDLE_TIMEOUT_MS = 120_000
/**
 * Idle ceiling while a FOREGROUND tool call is in flight (tool:call seen, no
 * tool:result yet). A long Bash run — a test suite, a CI-poll sleep — emits no
 * SDK message until its tool_result, so the short deadline would kill a
 * healthy session mid-tool (the "random session stops" bug). A genuinely dead
 * stream is still reaped once this longer ceiling elapses.
 */
export const CLAUDE_TOOL_IDLE_TIMEOUT_MS = 30 * 60_000
/** Absolute ceiling on a context compaction, independent of tool idle time. */
export const COMPACTION_STALL_TIMEOUT_MS = 10 * 60_000
// Safety net for a subagent whose terminal `task_notification` carries a
// status outside the mapper's known-terminal set (SDK schema drift) — it
// never clears `activeSubagentToolCallIds`, which otherwise blocks
// `inputStream.close()`/the result-drain watchdog forever. Generous window:
// legitimate subagents can run for several minutes.
export const SUBAGENT_STALL_TIMEOUT_MS = 10 * 60_000
/** After the last background subagent completes, the CLI normally resumes the
 *  parent on its own. Closing the input before that continuation starts makes
 *  every permission request of it fail with "Stream closed", so wait this long
 *  for a parent message before draining a stream that did not continue. */
export const BACKGROUND_CONTINUATION_GRACE_MS = 60_000
/** A `result` does not always end the stream: resuming a session killed
 *  mid-turn first settles the interrupted turn with an empty result, then
 *  runs the new prompt right away. Wait this long for a follow-up before
 *  closing the input it still needs for permission requests. */
export const RESULT_CONTINUATION_GRACE_MS = 3_000
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
  /**
   * Detaches the abort listener. The signal lives as long as the session, so
   * without this every resolved permission leaves a listener behind — memory
   * that grows with the number of tool calls, plus Node's
   * MaxListenersExceededWarning masking real leaks.
   */
  cleanup?: () => void
  /** The original input the SDK passed to canUseTool — used to echo back questions on resolve. */
  input: Record<string, unknown>
  requestKind: 'question' | 'permission'
}

class ClaudeInputStream implements AsyncIterable<SDKUserMessage> {
  private readonly messages: Array<{ message: SDKUserMessage; forced: boolean }>
  private waiting?: () => void
  private closed = false
  private queuedForcedMessages = 0
  private readonly unansweredMessages = new Set<string>()

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

  hasUnansweredInput(): boolean {
    return this.queuedForcedMessages > 0 || this.unansweredMessages.size > 0
  }

  acknowledgeResult(result: { user_message_uuid?: string; user_message_uuids?: string[] }): void {
    // One Claude turn can consume several queued prompts. A result counts
    // turns, not messages: only retire the sends explicitly covered by it.
    const ids = [...(result.user_message_uuids ?? []), ...(result.user_message_uuid ? [result.user_message_uuid] : [])]
    if (result.user_message_uuids !== undefined || result.user_message_uuid !== undefined) {
      for (const id of ids) this.unansweredMessages.delete(id)
    } else {
      // A legacy result can acknowledge an already delivered input, never a
      // future one (e.g. an interrupted turn's result on resume).
      const oldest = this.unansweredMessages.values().next().value
      if (oldest) this.unansweredMessages.delete(oldest)
    }
    const wake = this.waiting
    this.waiting = undefined
    wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage, void, undefined> {
    while (!this.closed || this.messages.length > 0) {
      // The SDK echoes at most 64 consumed UUIDs per result. Backpressure
      // prevents losing correlation without guessing which inputs were read.
      if (!this.closed && this.unansweredMessages.size >= 64) {
        await new Promise<void>((resolve) => {
          this.waiting = resolve
        })
        continue
      }
      const next = this.messages.shift()
      if (next) {
        if (next.forced) this.queuedForcedMessages--
        this.unansweredMessages.add(next.message.uuid!)
        yield next.message
        continue
      }
      await new Promise<void>((resolve) => {
        this.waiting = resolve
      })
    }
  }

  private toUserMessage(text: string): SDKUserMessage {
    return { type: 'user', uuid: randomUUID(), message: { role: 'user', content: text }, parent_tool_use_id: null }
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
      // Active sub-agents keyed by their canonical id (SDK task id when known,
      // else the tool call id), which is also the id passed to `q.stopTask`.
      // One task can surface under both ids (relaunch, kill/restart), so
      // running and terminal events must resolve to the same entry.
      const activeSubagentTaskIds = new Set<string>()
      // tool call id -> SDK task id, learned from events carrying both.
      const subagentTaskIdByToolCallId = new Map<string, string>()
      // Ambient tasks (SDK `ambient`, e.g. Monitor watchers) are not activity:
      // they never enter `activeSubagentTaskIds`, so they never block
      // turn:completed, keep the input open or arm the stall watchdog. They are
      // tracked apart only so a user interrupt still stops them.
      const ambientSubagentTaskIds = new Set<string>()
      // Canonical ids whose last lifecycle event was terminal: a late
      // `progress` for them is ignored, only a `started` relaunch revives them.
      const terminalSubagentTaskIds = new Set<string>()
      const trackSubagentProgress = (ev: Extract<AgentEvent, { kind: 'subagent:progress' }>): void => {
        if (ev.taskId) {
          subagentTaskIdByToolCallId.set(ev.toolCallId, ev.taskId)
          // Merge an entry first tracked under its tool call id alone.
          if (ev.toolCallId !== ev.taskId) {
            activeSubagentTaskIds.delete(ev.toolCallId)
            ambientSubagentTaskIds.delete(ev.toolCallId)
            if (terminalSubagentTaskIds.delete(ev.toolCallId)) terminalSubagentTaskIds.add(ev.taskId)
          }
        }
        const taskId = ev.taskId ?? subagentTaskIdByToolCallId.get(ev.toolCallId)
        const key = taskId ?? ev.toolCallId
        if (ev.status !== 'running') {
          activeSubagentTaskIds.delete(key)
          ambientSubagentTaskIds.delete(key)
          terminalSubagentTaskIds.add(key)
          return
        }
        if (ev.phase === 'progress' && terminalSubagentTaskIds.has(key)) return
        terminalSubagentTaskIds.delete(key)
        if (ev.ambient) {
          activeSubagentTaskIds.delete(key)
          ambientSubagentTaskIds.add(key)
        } else {
          ambientSubagentTaskIds.delete(key)
          activeSubagentTaskIds.add(key)
        }
      }
      // Foreground tool calls currently awaiting their tool_result. Cleared on
      // every `result` message: a turn cannot end with a tool still in flight.
      const pendingToolCallIds = new Set<string>()

      // Pending canUseTool callbacks, keyed by SDK ctx.toolUseID.
      const pendingResolvers = new Map<string, PendingResolver>()

      const isInteractive = options.agentPermissionMode === 'interactive'

      const canUseTool: CanUseTool = (toolName, input, ctx) => {
        const toolCallId =
          typeof ctx.toolUseID === 'string' && ctx.toolUseID.length > 0 ? ctx.toolUseID : `tu_${nanoid()}`

        // Plan mode alone is not read-only here: the non-interactive allow below
        // would approve ExitPlanMode and then every edit. Anything that needs a
        // permission, a question included, is refused outright instead.
        if (options.readOnly) {
          return Promise.resolve<PermissionResult>({
            behavior: 'deny',
            message:
              'This is a read-only review session: do not modify anything or ask the user. Put the finding in your final report instead.',
            interrupt: false,
          })
        }

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
          clearSubagentStallWatchdog()

          const onAbort = (): void => {
            if (pendingResolvers.get(toolCallId) === resolver) {
              pendingResolvers.delete(toolCallId)
              reevaluateLivenessPause()
              if (settlementPending) armContinuationGrace(RESULT_CONTINUATION_GRACE_MS)
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
          resolver.cleanup = () => ctx.signal.removeEventListener('abort', onAbort)

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
      let queryCloseRequested = false
      const terminateQuery = (): void => {
        if (queryCloseRequested) return
        queryCloseRequested = true
        inputStream.close()
        abortController.abort()
        turnLiveness.stop()
        clearContinuationGrace()
        clearResultDrainWatchdog()
        clearSubagentStallWatchdog()
        clearCompactionStallTimer()
        // Abort alone can leave the SDK iterator parked. close() explicitly
        // tears down its transport/process. Ownership still waits for closed.
        try {
          q.close?.()
        } catch (error) {
          console.warn('[claude-engine] SDK transport close failed:', error)
        }
      }
      // Best-effort SDK stop of one background task; failures are ignored.
      const requestStopTask = (taskId: string): void => {
        try {
          void q.stopTask(taskId).catch(() => {
            /* best-effort */
          })
        } catch {
          /* best-effort */
        }
      }

      let resolveReady!: () => void
      let rejectReady!: (error: Error) => void
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
      })
      // Legacy callers do not await readiness; still observe an early rejection.
      void ready.catch(() => {})
      let discoveredSessionId: string | undefined

      // A throwing onEvent handler (e.g. DB query against a closed connection
      // during async test teardown) must not escape as an unhandled rejection.
      const emitDirect = (ev: AgentEvent): void => {
        try {
          if (ev.kind === 'session:started') resolveReady()
          if (ev.kind === 'error') rejectReady(new Error(ev.message))
          if (ev.kind === 'session:ended')
            rejectReady(new Error('Claude ended before confirming session initialization'))
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
      let waitingForBackground = false
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
          isCompacting ||
          pendingToolCallIds.size > 0 ||
          inputStream.hasUnansweredInput()
        ) {
          return
        }
        turnCompletedEmittedForResponse = completedResponses
        safeEmit({ kind: 'turn:completed' })
      }

      // Guard so the post-result drain watchdog and the natural loop exit (or
      // catch block) never both emit `session:ended` for the same run.
      let sessionEndedEmitted = false
      let isCompacting = false
      let settlementPending = false
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
      // first SDK message, re-armed on meaningful progress, suspended while a human
      // decision or a background subagent is outstanding, stopped in `finally`.
      const turnLiveness = createTurnLiveness({
        timeoutMs: CLAUDE_STREAM_IDLE_TIMEOUT_MS,
        onTimeout() {
          // The armed deadline tracks whether a foreground tool call is in
          // flight (see `turnLiveness.setTimeoutMs` below) — log the duration
          // that actually elapsed, not always the shorter baseline, so the
          // watchdog's own diagnostic message stays trustworthy.
          const timeoutMs = pendingToolCallIds.size > 0 ? CLAUDE_TOOL_IDLE_TIMEOUT_MS : CLAUDE_STREAM_IDLE_TIMEOUT_MS
          console.warn(`[claude-engine] SDK stream reported no activity for ${timeoutMs}ms — forcing session:ended`)
          if (userInterrupted) emitSessionEnded('killed', null)
          else if (mapperState.sawErrorResult) emitSessionEnded('error', null)
          else {
            safeEmit({
              kind: 'error',
              category: 'other',
              message:
                'Session force-ended by the liveness watchdog: no SDK activity within the deadline. If the agent was legitimately busy, this is a bug worth reporting.',
              code: 'stream_idle_timeout',
            })
            emitSessionEnded('watchdog', null)
          }
          terminateQuery()
        },
      })
      // The single source of truth for "should the idle deadline be paused
      // right now" — a background subagent, a pending permission/question
      // card, or an in-progress compaction can each legitimately keep the
      // stream quiet for minutes; their own dedicated watchdogs own those
      // windows. Every call site that changes one of these three conditions
      // must re-evaluate through this helper, not duplicate the check.
      const reevaluateLivenessPause = (): void => {
        if (pendingResolvers.size > 0 || activeSubagentTaskIds.size === 0) clearSubagentStallWatchdog()
        else if (!subagentStallTimer) armSubagentStallWatchdog()
        if (activeSubagentTaskIds.size > 0 || pendingResolvers.size > 0 || isCompacting) turnLiveness.pause()
        else turnLiveness.resume()
      }
      // Backstop for a compaction that never reports completion (stuck
      // `session:compacting` with `active: true` forever): `isCompacting`
      // pauses `turnLiveness` indefinitely, and a wedged-but-alive generator
      // never trips `isAlive()`'s own sweep either. End it at the absolute
      // ceiling instead of adding another tool-aware idle window afterward.
      let compactionStallTimer: ReturnType<typeof setTimeout> | undefined
      const clearCompactionStallTimer = (): void => {
        if (!compactionStallTimer) return
        clearTimeout(compactionStallTimer)
        compactionStallTimer = undefined
      }
      const armCompactionStallTimer = (): void => {
        if (compactionStallTimer) return
        compactionStallTimer = setTimeout(() => {
          compactionStallTimer = undefined
          if (!isCompacting) return
          console.warn(
            `[claude-engine] Compaction still reported active ${COMPACTION_STALL_TIMEOUT_MS}ms after it started — closing the session.`,
          )
          isCompacting = false
          safeEmit({ kind: 'session:compacting', active: false })
          safeEmit({
            kind: 'error',
            category: 'other',
            code: 'compaction_stall_timeout',
            message: 'Session force-ended: context compaction stopped reporting completion (watchdog).',
          })
          emitSessionEnded('watchdog', null)
          terminateQuery()
        }, COMPACTION_STALL_TIMEOUT_MS)
        compactionStallTimer.unref?.()
      }
      const armResultDrainWatchdog = (): void => {
        if (resultDrainTimer) return
        resultDrainTimer = setTimeout(() => {
          console.warn(
            `[claude-engine] SDK generator still open ${RESULT_DRAIN_TIMEOUT_MS}ms after 'result' — forcing session:ended`,
          )
          if (userInterrupted) emitSessionEnded('killed', null)
          else if (mapperState.sawErrorResult) emitSessionEnded('error', null)
          else {
            safeEmit({
              kind: 'error',
              category: 'other',
              message: 'Session force-ended: the SDK generator stayed open after its final result (drain watchdog).',
              code: 'result_drain_timeout',
            })
            emitSessionEnded('watchdog', null)
          }
          terminateQuery()
        }, RESULT_DRAIN_TIMEOUT_MS)
        resultDrainTimer.unref?.()
      }
      const clearResultDrainWatchdog = (): void => {
        if (!resultDrainTimer) return
        clearTimeout(resultDrainTimer)
        resultDrainTimer = undefined
      }

      // Drain for a stream that may still continue: after a result, or after
      // the last background subagent completed. Any new init or parent
      // message cancels it, and that continuation's own `result` re-arms it.
      let continuationGraceTimer: ReturnType<typeof setTimeout> | undefined
      const clearContinuationGrace = (): void => {
        if (!continuationGraceTimer) return
        clearTimeout(continuationGraceTimer)
        continuationGraceTimer = undefined
      }
      const armContinuationGrace = (delayMs: number): void => {
        clearContinuationGrace()
        continuationGraceTimer = setTimeout(() => {
          continuationGraceTimer = undefined
          if (
            activeSubagentTaskIds.size > 0 ||
            pendingResolvers.size > 0 ||
            pendingToolCallIds.size > 0 ||
            isCompacting ||
            inputStream.hasUnansweredInput()
          )
            return
          // Settled only now: a result the CLI follows up on (e.g. a resumed
          // turn's empty result) must not hide the busy banner meanwhile.
          emitTurnCompletedIfSettled()
          inputStream.close()
          armResultDrainWatchdog()
        }, delayMs)
        continuationGraceTimer.unref?.()
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
      // Runs from the first task_started, including before the first result.
      // Human waits suspend it independently; genuine activity restarts it.
      const armSubagentStallWatchdog = (): void => {
        clearSubagentStallWatchdog()
        if (pendingResolvers.size > 0 || activeSubagentTaskIds.size === 0) return
        const hasAgent = [...activeSubagentTaskIds].some((id) =>
          isSubagentTask({ taskType: mapperState.taskTypes.get(id) }),
        )
        // Shell/workflow/MCP jobs do not emit agent progress during a long
        // command. Give them the same silence allowance as foreground tools.
        const timeoutMs = hasAgent ? SUBAGENT_STALL_TIMEOUT_MS : CLAUDE_TOOL_IDLE_TIMEOUT_MS
        subagentStallTimer = setTimeout(() => {
          subagentStallTimer = undefined
          if (pendingResolvers.size > 0 || activeSubagentTaskIds.size === 0) return
          console.warn(`[claude-engine] No background activity for ${timeoutMs}ms — forcing session:ended`)
          safeEmit({
            kind: 'error',
            category: 'other',
            message: hasAgent
              ? 'Session force-ended: background subagents stopped reporting activity (watchdog).'
              : 'Session force-ended: background tools stopped reporting activity (watchdog).',
            code: hasAgent ? 'subagent_stall_timeout' : 'background_task_stall_timeout',
          })
          emitSessionEnded('watchdog', null)
          terminateQuery()
        }, timeoutMs)
        subagentStallTimer.unref?.()
      }

      const iteratorPromise = (async () => {
        iteratorRunning = true
        turnLiveness.start()
        try {
          for await (const msg of q as AsyncIterable<SDKMessage>) {
            const events = mapSdkMessage(msg, mapperState)
            const isForeground = !('parent_tool_use_id' in msg && msg.parent_tool_use_id != null)
            const foregroundProgress =
              isForeground &&
              events.some(
                (ev) =>
                  ev.kind === 'message:text' ||
                  ev.kind === 'message:thinking' ||
                  ev.kind === 'tool:call' ||
                  ev.kind === 'tool:result',
              )
            // A parent continuation owns the foreground again. Background
            // progress notifications alone do not end the between-turn wait.
            if (foregroundProgress) {
              waitingForBackground = false
              settlementPending = false
              clearContinuationGrace()
              clearResultDrainWatchdog()
            } else if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'init') {
              // A new run starts on this stream (e.g. after a resumed turn's empty result).
              clearContinuationGrace()
              settlementPending = false
              clearResultDrainWatchdog()
            }
            for (const ev of events) {
              if (ev.kind === 'subagent:progress') trackSubagentProgress(ev)
            }
            if (
              activeSubagentTaskIds.size > 0 &&
              (events.some(
                (ev) =>
                  // An ambient watcher's progress is not proof that a real
                  // sub-agent advanced: it must not reset the stall bound.
                  (ev.kind === 'subagent:progress' && !ev.ambient) ||
                  ev.kind === 'message:text' ||
                  ev.kind === 'message:thinking' ||
                  ev.kind === 'tool:call' ||
                  ev.kind === 'tool:result',
              ) ||
                ('parent_tool_use_id' in msg && msg.parent_tool_use_id != null))
            )
              armSubagentStallWatchdog()
            for (const ev of events) {
              if (ev.kind === 'session:compacting') {
                const wasCompacting = isCompacting
                isCompacting = ev.active
                if (ev.active) {
                  clearContinuationGrace()
                  clearResultDrainWatchdog()
                  armCompactionStallTimer()
                } else {
                  clearCompactionStallTimer()
                  if (wasCompacting && settlementPending) armContinuationGrace(RESULT_CONTINUATION_GRACE_MS)
                }
              }
              // Older SDKs can emit only compact_boundary, without a trailing
              // status update. This boundary marks compaction as complete.
              else if (ev.kind === 'session:compacted') {
                isCompacting = false
                clearCompactionStallTimer()
                if (settlementPending) armContinuationGrace(RESULT_CONTINUATION_GRACE_MS)
              }
            }
            // Actual foreground output proves work resumed even if the SDK
            // omitted its trailing status/compact_boundary message. Tool results
            // and background progress can drain during compaction, so exclude them.
            if (
              isCompacting &&
              !('parent_tool_use_id' in msg && msg.parent_tool_use_id != null) &&
              events.some(
                (ev) => ev.kind === 'message:text' || ev.kind === 'message:thinking' || ev.kind === 'tool:call',
              )
            ) {
              isCompacting = false
              clearCompactionStallTimer()
              safeEmit({ kind: 'session:compacting', active: false })
            }
            for (const ev of events) {
              if (isForeground && ev.kind === 'tool:call') pendingToolCallIds.add(ev.toolCallId)
              else if (isForeground && ev.kind === 'tool:result') pendingToolCallIds.delete(ev.toolCallId)
            }
            // After a settled result, the last background completion drains
            // the stream only if the parent does not continue (see
            // BACKGROUND_CONTINUATION_GRACE_MS): its continuation still needs
            // the input for permission requests.
            if (subagentStallTimer && activeSubagentTaskIds.size === 0 && !inputStream.hasUnansweredInput()) {
              clearSubagentStallWatchdog()
              armContinuationGrace(BACKGROUND_CONTINUATION_GRACE_MS)
            }
            for (const ev of events) {
              if (ev.kind === 'session:started') discoveredSessionId = ev.engineSessionId
              safeEmit(ev)
            }
            // Transport metadata is not forward progress. In particular a
            // stream of trailing notifications must not defeat shutdown.
            if (
              foregroundProgress ||
              msg.type === 'result' ||
              events.some((ev) => ev.kind === 'subagent:progress' && !ev.ambient)
            )
              turnLiveness.activity()
            // A background subagent or a pending permission card can stay
            // legitimately quiet for minutes; their own dedicated watchdogs
            // own those windows, so suspend the turn deadline meanwhile.
            // A FOREGROUND tool call in flight keeps the deadline armed but
            // stretched to the tool-aware ceiling.
            turnLiveness.setTimeoutMs(
              pendingToolCallIds.size > 0 ? CLAUDE_TOOL_IDLE_TIMEOUT_MS : CLAUDE_STREAM_IDLE_TIMEOUT_MS,
            )
            reevaluateLivenessPause()
            if ((msg as { type?: string }).type === 'result') {
              waitingForBackground = false
              settlementPending = true
              clearContinuationGrace()
              pendingToolCallIds.clear()
              turnLiveness.setTimeoutMs(CLAUDE_STREAM_IDLE_TIMEOUT_MS)
              completedResponses++
              inputStream.acknowledgeResult(msg as { user_message_uuid?: string; user_message_uuids?: string[] })
              // A queued forced message starts the next response on this same SDK stream.
              if (!inputStream.hasUnansweredInput()) {
                if (activeSubagentTaskIds.size === 0) {
                  clearSubagentStallWatchdog()
                  armContinuationGrace(RESULT_CONTINUATION_GRACE_MS)
                } else {
                  waitingForBackground = true
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
          clearResultDrainWatchdog()
          clearContinuationGrace()
          turnLiveness.stop()
          clearSubagentStallWatchdog()
          clearCompactionStallTimer()
          // Drain any callback still pending (SDK terminated while awaiting an
          // answer). canUseTool's abort path covers signalled stops; this
          // covers natural iterator completion.
          for (const resolver of pendingResolvers.values()) {
            try {
              resolver.cleanup?.()
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
        ready,
        closed: iteratorPromise.then(() => {}),
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
          if (!iteratorRunning || queryCloseRequested || sessionEndedEmitted)
            throw new Error(`Claude ${AGENT_NO_LONGER_RUNNING_TEXT}`)
          inputStream.send(text)
          armSubagentStallWatchdog()
        },
        sendWakeupIfWaiting(text: string): boolean {
          if (
            !iteratorRunning ||
            abortController.signal.aborted ||
            mapperState.sawErrorResult ||
            !waitingForBackground ||
            activeSubagentTaskIds.size === 0 ||
            pendingToolCallIds.size > 0 ||
            pendingResolvers.size > 0 ||
            isCompacting ||
            inputStream.hasUnansweredInput()
          )
            return false
          inputStream.send(text)
          waitingForBackground = false
          // Sending a new turn restarts, but never removes, the stall bound.
          armSubagentStallWatchdog()
          return true
        },
        stopSubagents(ids?: string[]): number {
          const isRunning = (taskId: string): boolean =>
            (activeSubagentTaskIds.has(taskId) || ambientSubagentTaskIds.has(taskId)) &&
            isSubagentTask({ taskType: mapperState.taskTypes.get(taskId) })
          const targets = new Set<string>()
          if (ids === undefined) {
            for (const taskId of [...activeSubagentTaskIds, ...ambientSubagentTaskIds]) {
              if (isRunning(taskId)) targets.add(taskId)
            }
          } else {
            for (const id of ids) {
              // A card id is the SDK task id, or the tool call id when the
              // task id was not known yet: resolve both to the tracked entry.
              const taskId = isRunning(id) ? id : subagentTaskIdByToolCallId.get(id)
              if (taskId && isRunning(taskId)) targets.add(taskId)
            }
          }
          // The main turn keeps running: only the targeted tasks are stopped.
          // Their terminal notification clears the tracking as usual.
          for (const taskId of targets) requestStopTask(taskId)
          return targets.size
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
          for (const taskId of [...activeSubagentTaskIds, ...ambientSubagentTaskIds]) requestStopTask(taskId)
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
          terminateQuery()
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
          resolver.cleanup?.()
          // Re-evaluate rather than unconditionally resuming: a sibling
          // request, a still-active subagent, or an in-progress compaction
          // may each still have their own legitimate reason to keep the
          // deadline paused.
          reevaluateLivenessPause()

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
