import { resolve } from 'node:path'
import type { ContentBlock, McpServer } from '@agentclientprotocol/sdk'
import {
  buildKoboLaunchInstructions,
  getKoboPromptCapabilities,
  type KoboLaunchInstructions,
} from '../../../../../shared/launch-instructions.js'
import type { StartOptions } from '../types.js'
import { assertMistralSelection, MISTRAL_MODES } from './configuration.js'

export function buildMistralOptions(options: StartOptions): {
  cwd: string
  mcpServers: McpServer[]
  modeId: string
  prompt: ContentBlock[]
  koboInstructions: KoboLaunchInstructions
  env: NodeJS.ProcessEnv
} {
  if (options.resumeFromEngineSessionId !== undefined && !options.resumeFromEngineSessionId.trim())
    throw new Error('Mistral Vibe requires a nonempty saved session identity')
  const permissionMode = options.agentPermissionMode ?? 'interactive'
  const capabilities = getKoboPromptCapabilities(
    options.mcpServers?.find((server) => server.name === 'kobo-tasks')?.env,
  )
  if (permissionMode === 'plan' || options.readOnly || capabilities.handoff)
    throw new Error('Mistral Vibe does not support Plan or read-only launches')
  assertMistralSelection(options.model, 'model')
  assertMistralSelection(options.effort, 'thinking')
  if (!Object.hasOwn(MISTRAL_MODES, permissionMode)) throw new Error('Unsupported Mistral Vibe permission mode')
  const modeId = MISTRAL_MODES[permissionMode]
  const koboInstructions = buildKoboLaunchInstructions({
    engine: 'mistral-vibe',
    permissionMode,
    autoLoop: options.autoLoop,
    ...capabilities,
  })
  return {
    cwd: resolve(options.workingDir),
    modeId,
    koboInstructions,
    mcpServers: (options.mcpServers ?? []).map((server) => ({
      name: server.name,
      command: server.command,
      args: [...server.args],
      env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
    })),
    prompt: [{ type: 'text', text: `${koboInstructions.promptPrefix}\n\n${options.prompt}` }],
    env: { ...process.env, ...options.env },
  }
}
