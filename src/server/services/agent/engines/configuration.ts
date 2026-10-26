import { assertMistralSelection } from './mistral-vibe/configuration.js'
import type { AgentEngine } from './types.js'

/** Validate native selections before creating or replacing launch state. */
export function assertEngineConfigurationSupported(
  engine: AgentEngine,
  selection: { model?: unknown; reasoningEffort?: unknown; agentPermissionMode?: unknown; readOnly?: boolean },
): void {
  if (selection.readOnly && !engine.capabilities.supportsReadOnly)
    throw new Error(`Engine '${engine.id}' does not support read-only launches`)
  // Native membership is checked contextually and again on the actual ACP session.
  if (engine.id !== 'mistral-vibe') return
  const mode = selection.agentPermissionMode ?? 'interactive'
  if (!engine.capabilities.permissionModes.some((item) => item === mode))
    throw new Error(`Engine '${engine.id}' does not support agentPermissionMode '${String(mode)}'`)
  assertMistralSelection(selection.model, 'model')
  assertMistralSelection(selection.reasoningEffort, 'thinking')
}
