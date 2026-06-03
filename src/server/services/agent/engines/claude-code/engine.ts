import {
  type CanUseTool,
  type McpStdioServerConfig,
  type Options,
  type PermissionResult,
  query,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { nanoid } from 'nanoid'
import type { AgentEngine, AgentEvent, EngineProcess, StartOptions } from '../types.js'
import { CLAUDE_CODE_CAPABILITIES } from './capabilities.js'
import { createMapperState, mapSdkMessage, QUOTA_PATTERN, tryEmitQuota } from './event-mapper.js'
import { buildClaudeOptions } from './options-builder.js'
import { buildCompactionSessionStartOutput } from './precompact-hook.js'
import { resolveClaudeBinaryPath } from './resolve-binary.js'

type McpStdioServerConfigWithAlwaysLoad = McpStdioServerConfig & { alwaysLoad: boolean }

/**
 * Grace window between the SDK's terminal `result` message and the generator
 * reaching `done`. A healthy run closes within milliseconds; if the generator
 * stays parked past this (a hung subagent task or stuck MCP/teardown), the
 * post-result drain watchdog force-emits `session:ended` so the orchestrator
 * and auto-loop are not frozen forever.
 */
const RESULT_DRAIN_TIMEOUT_MS = 15_000

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

export function createClaudeCodeEngine(): AgentEngine {
  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    capabilities: CLAUDE_CODE_CAPABILITIES,
    async start(options: StartOptions, onEvent): Promise<EngineProcess> {
      const abortController = new AbortController()
      const mapperState = createMapperState()

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

        const requestKind: 'question' | 'permission' = toolName === 'AskUserQuestion' ? 'question' : 'permission'

        return new Promise<PermissionResult>((resolve, reject) => {
          const resolver: PendingResolver = { resolve, input, requestKind }
          pendingResolvers.set(toolCallId, resolver)

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
      })
      sdkOptions.abortController = abortController

      // Override the SDK's libc-blind binary resolution on Linux glibc — see
      // resolve-binary.ts for the full rationale. No-op on macOS/Windows/musl.
      const explicitBinary = resolveClaudeBinaryPath()
      if (explicitBinary) sdkOptions.pathToClaudeCodeExecutable = explicitBinary

      const q = query({ prompt: effectivePrompt, options: sdkOptions })

      let discoveredSessionId: string | undefined

      // A throwing onEvent handler (e.g. DB query against a closed connection
      // during async test teardown) must not escape as an unhandled rejection.
      const safeEmit = (ev: AgentEvent): void => {
        try {
          onEvent(ev)
        } catch (err) {
          console.error('[claude-engine] onEvent handler threw:', err)
        }
      }

      let iteratorRunning = false
      let userInterrupted = false

      // Guard so the post-result drain watchdog and the natural loop exit (or
      // catch block) never both emit `session:ended` for the same run.
      let sessionEndedEmitted = false
      const emitSessionEnded = (reason: 'completed' | 'error' | 'killed', exitCode: number | null): void => {
        if (sessionEndedEmitted) return
        sessionEndedEmitted = true
        safeEmit({ kind: 'session:ended', reason, exitCode })
      }

      // Post-result drain watchdog. The SDK emits a terminal `result` message
      // when the turn completes; the generator should then reach `done`
      // near-instantly. If it stays parked (a hung subagent task or stuck
      // teardown), the `for await` below would wait forever — `session:ended`
      // would never fire, freezing the orchestrator and the auto-loop. Once a
      // `result` is observed we arm a timer that force-emits `session:ended`
      // with the result's own outcome, then aborts the generator best-effort.
      let resultDrainTimer: ReturnType<typeof setTimeout> | undefined
      const armResultDrainWatchdog = (): void => {
        if (resultDrainTimer) return
        resultDrainTimer = setTimeout(() => {
          console.warn(
            `[claude-engine] SDK generator still open ${RESULT_DRAIN_TIMEOUT_MS}ms after 'result' — forcing session:ended`,
          )
          const reason = userInterrupted ? 'killed' : mapperState.sawErrorResult ? 'error' : 'completed'
          emitSessionEnded(reason, reason === 'completed' ? 0 : null)
          // Best-effort: unstick the SDK so its subprocesses / MCP children
          // tear down. The session is reported ended regardless of whether
          // the abort actually propagates through the parked generator.
          abortController.abort()
        }, RESULT_DRAIN_TIMEOUT_MS)
        resultDrainTimer.unref?.()
      }

      const iteratorPromise = (async () => {
        iteratorRunning = true
        try {
          for await (const msg of q as AsyncIterable<SDKMessage>) {
            const events = mapSdkMessage(msg, mapperState)
            for (const ev of events) {
              if (ev.kind === 'session:started') discoveredSessionId = ev.engineSessionId
              safeEmit(ev)
            }
            if ((msg as { type?: string }).type === 'result') armResultDrainWatchdog()
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
          // The post-result drain watchdog (if armed) is moot once the
          // iterator has exited — clear it so a healthy run never triggers a
          // stray abort after it already ended.
          if (resultDrainTimer) {
            clearTimeout(resultDrainTimer)
            resultDrainTimer = undefined
          }
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
        sendMessage() {
          throw new Error('sendMessage not supported in single-shot SDK mode')
        },
        interrupt() {
          userInterrupted = true
          // The SDK ends an interrupted run by emitting a `result` with
          // subtype `error_during_execution` through the normal iterator —
          // the mapper needs this flag to treat it as a clean stop.
          mapperState.userInterrupted = true
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
