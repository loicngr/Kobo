import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import * as acp from '@agentclientprotocol/sdk'
import type { MistralOptions } from '../../shared/mistral-options.js'
import {
  closeVibeAcpSession,
  connectVibeAcp,
  requestVibeAcp,
  type VibeAcpConnection,
} from './agent/engines/mistral-vibe/client.js'
import {
  assertMistralSelection,
  MISTRAL_MODES,
  readMistralSelect,
  requireMistralOption,
} from './agent/engines/mistral-vibe/configuration.js'
import { spawnVibeAcp } from './agent/engines/mistral-vibe/spawn.js'
import { getWorkspace } from './workspace-service.js'

interface Context {
  workspaceId?: string
  projectPath?: string
  model?: string
  agentPermissionMode?: string
}
const pending = new Map<string, Promise<MistralOptions>>()
const cache = new Map<string, { expires: number; options: MistralOptions }>()
let owned = 0

export async function getMistralOptions(input: Context): Promise<MistralOptions> {
  for (const [key, value] of Object.entries(input)) {
    if (
      value !== undefined &&
      (typeof value !== 'string' ||
        !value.trim() ||
        value.length > (key === 'projectPath' ? 4096 : 256) ||
        value.includes('\0'))
    )
      throw new Error(`Invalid Mistral Vibe ${key}`)
  }
  if (input.workspaceId && input.projectPath) throw new Error('Choose workspaceId or projectPath, not both')
  const permission = input.agentPermissionMode ?? 'interactive'
  if (!Object.hasOwn(MISTRAL_MODES, permission))
    throw new Error('Mistral Vibe requires a supported native permission mode')
  assertMistralSelection(input.model, 'model')
  const workspace = input.workspaceId ? getWorkspace(input.workspaceId) : undefined
  if (input.workspaceId && !workspace) throw new Error('Workspace not found')
  if (
    workspace &&
    (typeof workspace.worktreePath !== 'string' || !workspace.worktreePath || workspace.worktreePurgedAt)
  )
    throw new Error('Restore the workspace context before discovering Vibe options')
  const cwd = resolve(workspace?.worktreePath ?? input.projectPath ?? homedir())
  if (!(await stat(cwd).catch(() => undefined))?.isDirectory())
    throw new Error('Mistral Vibe context directory does not exist')
  const mode = MISTRAL_MODES[permission as keyof typeof MISTRAL_MODES]
  const model = input.model && input.model !== 'auto' ? input.model : undefined
  const key = JSON.stringify([cwd, mode, model])
  const cached = cache.get(key)
  if (cached && cached.expires > Date.now()) return cached.options
  const existing = pending.get(key)
  if (existing) return existing
  if (owned >= 4) throw new Error('Mistral Vibe discovery is busy or awaiting native closure; try again after closure')
  owned++
  const probe = (async () => {
    let runtime: ReturnType<typeof spawnVibeAcp>
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^KOBO_.*TOKEN$/.test(name)))
      runtime = spawnVibeAcp({
        cwd,
        env: { ...env, VIBE_DEFAULT_AGENT: mode, ...(model ? { VIBE_ACTIVE_MODEL: model } : {}) },
      })
    } catch {
      owned--
      throw new Error('Cannot start native Vibe discovery; check vibe-acp on PATH')
    }
    let connection: VibeAcpConnection | undefined
    let sessionId: string | undefined
    let canClose = false
    // Failed shutdown never releases a slot while native ownership remains unresolved.
    void runtime.closed.then(() => {
      owned--
      connection?.close()
    })
    try {
      connection = connectVibeAcp(runtime.child, {
        requestPermission: () => ({ outcome: { outcome: 'cancelled' } }),
        createElicitation: () => ({ action: 'cancel' }),
      })
      const initialized = await requestVibeAcp(connection, acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      })
      const capabilities = initialized.agentCapabilities
      if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities))
        throw new Error('Invalid Vibe ACP capabilities')
      if (
        capabilities.sessionCapabilities != null &&
        (typeof capabilities.sessionCapabilities !== 'object' || Array.isArray(capabilities.sessionCapabilities))
      )
        throw new Error('Invalid Vibe ACP session capabilities')
      const close = capabilities.sessionCapabilities?.close
      if (close != null && (typeof close !== 'object' || Array.isArray(close)))
        throw new Error('Invalid Vibe ACP close capability')
      canClose = close != null
      const session = await requestVibeAcp(connection, acp.methods.agent.session.new, { cwd, mcpServers: [] })
      sessionId = session.sessionId
      if (sessionId.length > 256 || sessionId.includes('\0')) throw new Error('Invalid Vibe ACP identity')
      requireMistralOption(session, 'mode', mode, true)
      if (model) requireMistralOption(session, 'model', model, true)
      const options = { model: readMistralSelect(session, 'model')!, thinking: readMistralSelect(session, 'thinking')! }
      await runtime.stop(() => closeVibeAcpSession(connection!, { sessionId: sessionId!, active: false, canClose }))
      await runtime.closed
      if (cache.size >= 32) cache.delete(cache.keys().next().value!)
      cache.set(key, { options, expires: Date.now() + 30_000 })
      return options
    } catch {
      throw new Error(
        'Native Vibe options unavailable; check the executable, authentication, project/profile and selected model, then retry',
      )
    } finally {
      await runtime
        .stop(
          connection && sessionId
            ? () => closeVibeAcpSession(connection!, { sessionId: sessionId!, active: false, canClose })
            : undefined,
        )
        .catch(() => {
          throw new Error(
            'Native Vibe discovery shutdown unconfirmed; ownership retained until confirmed closure or server restart',
          )
        })
    }
  })()
  pending.set(key, probe)
  try {
    return await probe
  } finally {
    pending.delete(key)
  }
}

/** External mutation preflight; the actual new/load session is still authoritative. */
export async function preflightMistralConfiguration(
  engine: string,
  context: Pick<Context, 'workspaceId' | 'projectPath'>,
  selection: { model?: unknown; reasoningEffort?: unknown; agentPermissionMode?: unknown },
  resume = false,
): Promise<void> {
  if (engine !== 'mistral-vibe') return
  assertMistralSelection(selection.model, 'model')
  assertMistralSelection(selection.reasoningEffort, 'thinking')
  // New-session defaults cannot validate thinking for an Auto model pinned in a saved session.
  if (resume && (selection.model === undefined || selection.model === 'auto')) return
  if (
    (selection.model === undefined || selection.model === 'auto') &&
    (selection.reasoningEffort === undefined || selection.reasoningEffort === 'auto')
  )
    return
  const options = await getMistralOptions({
    ...context,
    model: selection.model as string | undefined,
    agentPermissionMode: selection.agentPermissionMode as string | undefined,
  })
  if (
    selection.reasoningEffort !== undefined &&
    selection.reasoningEffort !== 'auto' &&
    !options.thinking.options.some((option) => option.value === selection.reasoningEffort)
  )
    throw new Error('Mistral Vibe thinking selection is unavailable for this model; refresh native options')
}
