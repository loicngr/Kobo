import {
  buildKoboLaunchInstructions,
  getKoboPromptCapabilities,
  type KoboLaunchInstructions,
} from '../../../../../shared/launch-instructions.js'
import type { CollaborationMode, ModelReasoningEffort, ThreadStartParams, UserInput } from './protocol/types.js'

export type AgentPermissionMode = 'plan' | 'bypass' | 'strict' | 'interactive'

export interface BuildCodexOptionsInput {
  prompt: string
  model?: string
  effort?: string
  /** Unified SDK-aligned permission mode (plan | bypass | strict | interactive). */
  agentPermissionMode: AgentPermissionMode
  /** Review session with an automatic return: read-only sandbox, never waits on the user. */
  readOnly?: boolean
  autoLoop?: boolean
  /** Native thread to resume; current launch instructions are refreshed on every launch. */
  resumeFromEngineSessionId?: string
  workingDir: string
  /** Kōbō McpServerSpec list, raw — function flattens into `config.mcp_servers` */
  mcpServers?: Array<{ name: string; command: string; args: string[]; env: Record<string, string> }>
}

export interface BuildCodexOptionsResult {
  threadParams: ThreadStartParams
  input: UserInput[]
  isResume: boolean
  koboInstructions: KoboLaunchInstructions
  /** Always emitted after the engine fills in the thread's resolved default model. */
  collaborationMode: Omit<CollaborationMode, 'settings'> & {
    settings: Omit<CollaborationMode['settings'], 'model'> & { model?: string }
  }
}

export function buildCodexOptions(input: BuildCodexOptionsInput): BuildCodexOptionsResult {
  const isResume = input.resumeFromEngineSessionId !== undefined

  const threadParams: ThreadStartParams = {
    cwd: input.workingDir,
    experimentalRawEvents: false,
    persistExtendedHistory: false,
  }

  // Permission mode → (sandbox, approvalPolicy)
  switch (input.agentPermissionMode) {
    case 'plan':
      threadParams.sandbox = 'read-only'
      threadParams.approvalPolicy = 'never'
      break
    case 'bypass':
      threadParams.sandbox = 'danger-full-access'
      threadParams.approvalPolicy = 'never'
      break
    case 'strict':
      threadParams.sandbox = 'workspace-write'
      threadParams.approvalPolicy = 'on-request'
      break
    case 'interactive':
      threadParams.sandbox = 'workspace-write'
      threadParams.approvalPolicy = 'unless-trusted'
      break
  }
  if (input.readOnly) {
    threadParams.sandbox = 'read-only'
    threadParams.approvalPolicy = 'never'
  }

  // Model: omit when undefined or 'auto', let Codex use its default
  if (input.model && input.model !== 'auto') {
    threadParams.model = input.model
  }

  // Effort: omit when undefined or 'auto'. `minimal` was emitted by older
  // Kōbō versions; Codex 5.6 rejects it, so preserve old workspaces by
  // translating it to the closest current setting instead of failing a turn.
  if (input.effort && input.effort !== 'auto') {
    threadParams.modelReasoningEffort = (input.effort === 'minimal' ? 'none' : input.effort) as ModelReasoningEffort
  }

  // `default_tools_approval_mode: 'auto'` pre-approves the namespace —
  // without it Codex blocks every MCP tool call with "user cancelled".
  if (input.mcpServers && input.mcpServers.length > 0) {
    type McpServerEntry = {
      enabled: boolean
      command: string
      args: string[]
      env: Record<string, string>
      default_tools_approval_mode: string
    }
    const mcpServersConfig: Record<string, McpServerEntry> = {}
    for (const srv of input.mcpServers) {
      mcpServersConfig[srv.name] = {
        enabled: true,
        command: srv.command,
        args: srv.args,
        env: srv.env,
        default_tools_approval_mode: 'auto',
      }
    }
    threadParams.config = { mcp_servers: mcpServersConfig }
  }

  const capabilities = getKoboPromptCapabilities(input.mcpServers?.find((server) => server.name === 'kobo-tasks')?.env)
  const koboInstructions = buildKoboLaunchInstructions({
    engine: 'codex',
    permissionMode: input.agentPermissionMode,
    readOnly: input.readOnly,
    autoLoop: input.autoLoop,
    ...capabilities,
  })
  const effectivePrompt = `${koboInstructions.promptPrefix}\n\n${input.prompt}`

  // Always emit collaborationMode — it's sticky server-side, so omitting it
  // would leave a resumed thread stuck in the previous turn's mode. Plan also
  // gates the `request_user_input` internal tool. Settings echo the resolved
  // model/effort because collaborationMode takes precedence over them. Automatic
  // model selection is filled from thread/start or thread/resume by the engine.
  const collaborationMode: BuildCodexOptionsResult['collaborationMode'] = {
    // A read-only review must not stop on a plan-mode question (see readOnly).
    mode: input.agentPermissionMode === 'plan' && !input.readOnly ? 'plan' : 'default',
    settings: {
      ...(threadParams.model ? { model: threadParams.model } : {}),
      reasoning_effort: (threadParams.modelReasoningEffort as ModelReasoningEffort | undefined) ?? null,
      developer_instructions: null,
    },
  }

  return {
    threadParams,
    input: [{ type: 'text', text: effectivePrompt, text_elements: [] }],
    isResume,
    koboInstructions,
    collaborationMode,
  }
}
