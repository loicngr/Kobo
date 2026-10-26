import { randomUUID } from 'node:crypto'
import * as acp from '@agentclientprotocol/sdk'
import { isWorkspacePermissionAllowed } from '../../../workspace-permission-policy-service.js'
import { createTurnLiveness } from '../../turn-liveness.js'
import { AGENT_NO_LONGER_RUNNING_TEXT, type AgentEngine, type AgentEvent, type EngineProcess } from '../types.js'
import { MISTRAL_CAPABILITIES } from './capabilities.js'
import { closeVibeAcpSession, connectVibeAcp, requestVibeAcp, type VibeAcpConnection } from './client.js'
import { readMistralSelect, requireMistralOption } from './configuration.js'
import { createMistralEventMapper } from './event-mapper.js'
import { buildMistralOptions } from './options-builder.js'
import { createMistralServerRequests } from './server-requests.js'
import { spawnVibeAcp } from './spawn.js'

function receipt() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function invalidResponse(): never {
  throw new Error('Invalid Vibe ACP setup response')
}

function diagnostic(error: unknown, stage: string): Extract<AgentEvent, { kind: 'error' }> {
  const message = error instanceof Error ? error.message : ''
  if (/missing.*api.?key|auth|credential|\b401\b|\b403\b/i.test(message))
    return {
      kind: 'error',
      category: 'other',
      code: 'acp_auth_required',
      message:
        'Mistral Vibe authentication is required; check the native Vibe authentication configuration for the server user.',
    }
  if (/quota|rate.?limit|\b429\b/i.test(message))
    return {
      kind: 'error',
      category: 'quota',
      code: 'acp_quota',
      message: 'Mistral Vibe reported a quota or rate limit; check the provider limits before retrying.',
    }
  if (/^Mistral Vibe .*selection is unavailable/.test(message))
    return { kind: 'error', category: 'other', code: 'acp_configuration_unavailable', message }
  if (/Invalid Vibe ACP/i.test(message))
    return {
      kind: 'error',
      category: 'parse_error',
      code: 'acp_invalid_response',
      message: 'Mistral Vibe returned an incompatible ACP response; ACP v1 and supported native modes are required.',
    }
  // resume_failed clears native identity and permits a fresh auto-loop conversation.
  if (stage === 'load')
    return {
      kind: 'error',
      category: 'other',
      code: 'acp_load_failed',
      message: 'Mistral Vibe could not load the saved session. No new conversation was started.',
    }
  return {
    kind: 'error',
    category: stage === 'connect' ? 'spawn_failed' : 'other',
    code: `acp_${stage}_failed`,
    message: `Mistral Vibe ${stage} failed. Check the native executable, configuration and provider connection before retrying.`,
  }
}

export function createMistralVibeEngine(): AgentEngine {
  return {
    id: 'mistral-vibe',
    displayName: 'Mistral Vibe',
    capabilities: MISTRAL_CAPABILITIES,
    async start(options, onEvent): Promise<EngineProcess> {
      // All unsupported launch choices fail before runtime ownership exists.
      const built = buildMistralOptions(options)
      const runtime = spawnVibeAcp({ cwd: built.cwd, env: built.env })
      const ready = receipt()
      const accepted = receipt()
      let connection: VibeAcpConnection | undefined
      let sessionId = options.resumeFromEngineSessionId
      let canClose = false
      let active = false
      let live = false
      let ended = false
      let physicallyClosed = false
      let mappedError = false
      let shutdownPromise: Promise<void> | undefined
      const tools = new Set<string>()
      const liveness = createTurnLiveness({
        timeoutMs: 120_000,
        enabled: options.watchdogEnabled === true,
        onTimeout: () =>
          end('watchdog', {
            kind: 'error',
            category: 'other',
            code: 'acp_watchdog',
            message: 'Mistral Vibe stopped reporting foreground activity for this turn.',
          }),
      })
      const emit = (event: AgentEvent) => {
        if (ended) return
        if (
          event.kind === 'message:text' ||
          event.kind === 'message:thinking' ||
          event.kind === 'tool:call' ||
          event.kind === 'tool:result'
        ) {
          if (event.kind === 'tool:call') tools.add(event.toolCallId)
          if (event.kind === 'tool:result') tools.delete(event.toolCallId)
          liveness.setTimeoutMs(tools.size ? 30 * 60_000 : 120_000)
          liveness.activity()
        }
        if (event.kind === 'error') {
          mappedError = true
          // Typed native notices may include provider details; expose fixed actionable diagnostics.
          if (!event.code && event.category !== 'parse_error') event = diagnostic(new Error(event.message), 'prompt')
        }
        onEvent(event)
      }
      const mapper = createMistralEventMapper(randomUUID(), emit)
      let requests: ReturnType<typeof createMistralServerRequests> | undefined
      const shutdown = (): Promise<void> => {
        if (!shutdownPromise) {
          shutdownPromise = runtime.stop(
            connection && sessionId
              ? () => closeVibeAcpSession(connection!, { sessionId: sessionId!, active, canClose })
              : undefined,
          )
          void shutdownPromise.catch(() => {})
        }
        return shutdownPromise
      }
      function end(
        reason: 'completed' | 'error' | 'killed' | 'watchdog',
        error?: Extract<AgentEvent, { kind: 'error' }>,
      ) {
        if (ended) return
        liveness.stop()
        requests?.cancelAll()
        mapper.flush()
        if (error) emit(error)
        ended = true
        const failure = new Error(
          error?.message ?? 'Mistral Vibe ended before initial prompt consumption was confirmed',
        )
        ready.reject(failure)
        accepted.reject(failure)
        if (reason === 'completed') onEvent({ kind: 'turn:completed' })
        onEvent({ kind: 'session:ended', reason, exitCode: reason === 'completed' ? 0 : null })
        void shutdown()
      }
      const onClose = () => {
        if (!ended) end('error', diagnostic(new Error('Native transport closed'), active ? 'prompt' : 'setup'))
      }
      runtime.child.once('close', onClose)
      void runtime.closed
        .then(() => {
          physicallyClosed = true
          onClose()
          runtime.child.removeListener('close', onClose)
          // SDK close cancels its receive reader; only do this after native EOF cleanup.
          connection?.close()
        })
        .catch(() => {})

      const run = async () => {
        let stage = 'connect'
        try {
          connection = connectVibeAcp(runtime.child, {
            sessionUpdate: ({ params }) => {
              if (ended || !sessionId || params.sessionId !== sessionId) return
              // Plans synthesize tool events; only native foreground signals prove prompt consumption.
              const update = params.update
              if (
                live &&
                (update.sessionUpdate === 'tool_call' ||
                  update.sessionUpdate === 'tool_call_update' ||
                  ((update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') &&
                    update.content.type === 'text' &&
                    update.content.text.length > 0))
              )
                accepted.resolve()
              mapper.onUpdate(params)
              if (
                live &&
                [
                  'agent_message_chunk',
                  'agent_thought_chunk',
                  'tool_call',
                  'tool_call_update',
                  'plan',
                  'compaction_update',
                ].includes(params.update.sessionUpdate)
              )
                liveness.activity()
            },
            requestPermission: (context) =>
              live && !ended && requests ? requests.requestPermission(context) : { outcome: { outcome: 'cancelled' } },
            createElicitation: (context) =>
              live && !ended && requests ? requests.createElicitation(context) : { action: 'cancel' },
          })
          void connection.closed.then(onClose, onClose)
          stage = 'initialize'
          const initialized = await requestVibeAcp(connection, acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: { elicitation: { form: {} } },
          })
          if (ended) return
          if (
            !record(initialized) ||
            initialized.protocolVersion !== acp.PROTOCOL_VERSION ||
            !record(initialized.agentCapabilities)
          )
            invalidResponse()
          const capabilities = initialized.agentCapabilities
          if (capabilities.loadSession != null && typeof capabilities.loadSession !== 'boolean') invalidResponse()
          if (capabilities.sessionCapabilities != null && !record(capabilities.sessionCapabilities)) invalidResponse()
          const close = capabilities.sessionCapabilities?.close
          if (close != null && !record(close)) invalidResponse()
          canClose = close != null
          if (options.resumeFromEngineSessionId && capabilities.loadSession !== true) invalidResponse()
          stage = options.resumeFromEngineSessionId ? 'load' : 'setup'
          const params = { cwd: built.cwd, mcpServers: built.mcpServers }
          const session = options.resumeFromEngineSessionId
            ? await requestVibeAcp(connection, acp.methods.agent.session.load, {
                ...params,
                sessionId: options.resumeFromEngineSessionId,
              })
            : await requestVibeAcp(connection, acp.methods.agent.session.new, params)
          if (ended) return
          if (!record(session)) invalidResponse()
          if (!options.resumeFromEngineSessionId) {
            if (!('sessionId' in session) || typeof session.sessionId !== 'string' || !session.sessionId.trim())
              invalidResponse()
            sessionId = session.sessionId
          }
          if (
            !sessionId ||
            !record(session.modes) ||
            typeof session.modes.currentModeId !== 'string' ||
            !Array.isArray(session.modes.availableModes) ||
            !session.modes.availableModes.every((mode) => record(mode) && typeof mode.id === 'string') ||
            !session.modes.availableModes.some((mode) => mode.id === built.modeId)
          )
            invalidResponse()
          requireMistralOption(session, 'mode', built.modeId)
          readMistralSelect(session, 'model', false)
          requests = createMistralServerRequests({
            sessionId,
            readOnly: false,
            emit,
            getTool: mapper.getTool,
            canonicalToolCallId: mapper.canonicalToolCallId,
            autoApprove: (toolName, payload) =>
              isWorkspacePermissionAllowed(options.workspaceId, { engine: 'mistral-vibe', toolName, payload }),
            onPendingChange: (count) => {
              if (count > 0) liveness.pause()
              else if (!ended) liveness.resume()
            },
          })
          stage = 'configuration'
          let configured = await requestVibeAcp(connection, acp.methods.agent.session.setConfigOption, {
            sessionId,
            configId: 'mode',
            value: built.modeId,
          })
          if (ended) return
          requireMistralOption(configured, 'mode', built.modeId, true)
          for (const [configId, value] of [
            ['model', options.model],
            ['thinking', options.effort],
          ] as const) {
            if (!value || value === 'auto') continue
            requireMistralOption(configured, configId, value)
            configured = await requestVibeAcp(connection, acp.methods.agent.session.setConfigOption, {
              sessionId,
              configId,
              value,
            })
            if (ended) return
            requireMistralOption(configured, configId, value, true)
            requireMistralOption(configured, 'mode', built.modeId, true)
          }
          if (options.model && options.model !== 'auto') requireMistralOption(configured, 'model', options.model, true)
          const model = readMistralSelect(configured, 'model', false)?.currentValue
          try {
            options.onPromptPrepared?.(built.koboInstructions)
          } catch {
            console.warn('[mistral-vibe] Could not persist prepared launch instructions')
          }
          if (ended) return
          emit({ kind: 'session:started', engineSessionId: sessionId, ...(model ? { model } : {}) })
          if (ended) return
          stage = 'prompt'
          active = true
          live = true
          mapper.beginLive()
          liveness.start()
          const pending = requestVibeAcp(connection, acp.methods.agent.session.prompt, {
            sessionId,
            prompt: built.prompt,
          })
          ready.resolve()
          const result = await pending
          if (ended) return
          active = false
          mapper.finish(result)
          if (result.stopReason === 'end_turn' && !mappedError) {
            accepted.resolve()
            end('completed')
          } else if (result.stopReason === 'cancelled') {
            end('error', {
              kind: 'error',
              category: 'other',
              code: 'acp_cancelled',
              message: 'Mistral Vibe cancelled the prompt without a local stop request.',
            })
          } else end('error')
        } catch (error) {
          if (!ended) end('error', diagnostic(error, stage))
        }
      }
      // start() must return ownership even when asynchronous setup/cleanup fails.
      void run()
      return {
        ready: ready.promise,
        initialPromptAccepted: accepted.promise,
        closed: runtime.closed,
        pid: runtime.child.pid,
        get engineSessionId() {
          return sessionId
        },
        isAlive: () => !physicallyClosed,
        sendMessage() {
          if (physicallyClosed) throw new Error(`Mistral Vibe ${AGENT_NO_LONGER_RUNNING_TEXT}`)
          throw new Error(
            'Mistral Vibe live message delivery is unsupported; wait for native closure and resume the conversation',
          )
        },
        interrupt() {
          end('killed')
        },
        stop() {
          end('killed')
          return shutdown()
        },
        hasPendingUserInput: (id) => requests?.hasPendingUserInput(id) ?? false,
        resolvePendingUserInput: (id, response) => requests?.resolvePendingUserInput(id, response) ?? false,
      }
    },
  }
}
