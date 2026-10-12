import type { CanUseTool, Options } from '@anthropic-ai/claude-agent-sdk'
import {
  buildKoboLaunchInstructions,
  getKoboPromptCapabilities,
  type KoboLaunchInstructions,
} from '../../../../../shared/launch-instructions.js'

export type AgentPermissionMode = 'plan' | 'bypass' | 'strict' | 'interactive'

export interface BuildClaudeOptionsInput {
  prompt: string
  model?: string
  effort?: string
  /** Unified SDK-aligned permission mode (plan | bypass | strict | interactive). */
  agentPermissionMode: AgentPermissionMode
  readOnly?: boolean
  autoLoop?: boolean
  resumeFromEngineSessionId?: string
  workingDir: string
  mcpServers?: Options['mcpServers']
  hooks?: Options['hooks']
  canUseTool?: CanUseTool
  stderr?: (data: string) => void
  env?: Record<string, string | undefined>
}

export interface BuildClaudeOptionsResult {
  options: Options
  effectivePrompt: string
  koboInstructions: KoboLaunchInstructions
}

export function buildClaudeOptions(input: BuildClaudeOptionsInput): BuildClaudeOptionsResult {
  const managedServer = input.mcpServers?.['kobo-tasks']
  const capabilities = getKoboPromptCapabilities(
    managedServer && 'env' in managedServer ? managedServer.env : undefined,
  )
  const koboInstructions = buildKoboLaunchInstructions({
    engine: 'claude-code',
    permissionMode: input.agentPermissionMode,
    readOnly: input.readOnly,
    autoLoop: input.autoLoop,
    ...capabilities,
  })
  const options: Options = {
    cwd: input.workingDir,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: koboInstructions.systemAppend },
    // Kōbō persists wakeups independently of the SDK and creates a fresh
    // controller when they fire. The native wakeup is bound to one SDK stream,
    // so it can outlive Kōbō's controller and produce unanswerable questions.
    disallowedTools: ['ScheduleWakeup'],
    // Leave `tools` undefined: the `claude_code` preset EXCLUDES MCP tools, so
    // under bypassPermissions MCP tools surface as "haven't granted it yet"
    // even when the user chose bypass. Undefined → full toolbox (built-ins +
    // MCP), matching pre-SDK CLI behaviour.
    //
    // `settingSources` defaults to [] in the SDK; we must opt in to all three
    // levels. Restricting to ['project'] makes the SDK skip the user-level
    // `~/.claude/settings.json` (where `skipDangerousModePermissionPrompt`
    // lives), breaking bypass for MCP tools.
    settingSources: ['user', 'project', 'local'],
    // Relay the Anthropic API's raw message stream so Kōbō can display true
    // text deltas instead of waiting for complete assistant content blocks.
    includePartialMessages: true,
  }

  switch (input.agentPermissionMode) {
    case 'plan':
      options.permissionMode = 'plan'
      break
    case 'bypass':
      options.permissionMode = 'bypassPermissions'
      options.allowDangerouslySkipPermissions = true
      break
    case 'strict':
      options.permissionMode = 'acceptEdits'
      break
    case 'interactive':
      // SDK 'default' + our canUseTool hook → every tool that would prompt is
      // deferred to the user via a workspace-level permission request.
      options.permissionMode = 'default'
      break
  }

  const prompt = `${koboInstructions.promptPrefix}\n\n${input.prompt}`

  if (input.model && input.model !== 'auto') options.model = input.model
  if (input.effort && input.effort !== 'auto') options.extraArgs = { effort: input.effort }
  if (input.mcpServers && Object.keys(input.mcpServers).length > 0) {
    options.mcpServers = input.mcpServers
  }
  if (input.resumeFromEngineSessionId) options.resume = input.resumeFromEngineSessionId
  if (input.hooks) options.hooks = input.hooks
  if (input.canUseTool) options.canUseTool = input.canUseTool
  if (input.stderr) options.stderr = input.stderr
  if (input.env) options.env = input.env

  return { options, effectivePrompt: prompt, koboInstructions }
}
