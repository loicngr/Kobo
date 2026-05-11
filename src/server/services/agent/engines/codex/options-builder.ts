import type { CollaborationMode, ModelReasoningEffort, ThreadStartParams, UserInput } from './protocol/types.js'

export type AgentPermissionMode = 'plan' | 'bypass' | 'strict' | 'interactive'

export interface BuildCodexOptionsInput {
  prompt: string
  model?: string
  effort?: string // 'auto' | 'low' | 'medium' | 'high'
  /** Unified SDK-aligned permission mode (plan | bypass | strict | interactive). */
  agentPermissionMode: AgentPermissionMode
  /**
   * Used only as a boolean signal: when set, the Kōbō MCP brief is NOT prepended
   * (resume sessions already have context). The value itself is not echoed in the result;
   * the calling engine decides whether to call startThread or resumeThread.
   */
  resumeFromEngineSessionId?: string
  workingDir: string
  /** Kōbō McpServerSpec list, raw — function flattens into `config.mcp_servers` */
  mcpServers?: Array<{ name: string; command: string; args: string[]; env: Record<string, string> }>
}

export interface BuildCodexOptionsResult {
  threadParams: ThreadStartParams
  input: UserInput[]
  isResume: boolean
  /** Always emitted — sticky server-side, gates `request_user_input` in `plan`. */
  collaborationMode: CollaborationMode
}

const CODEX_KOBO_MCP_BRIEF = [
  '[Kōbō MCP] This workspace exposes a dedicated MCP server named `kobo-tasks`. The Codex CLI surfaces its tools under the literal name `mcp__kobo-tasks__<tool>` — always use that full form when invoking them.',
  'Plan mode: when running with a read-only sandbox, the read-only restriction applies to MCP tools too. Reads (`mcp__kobo-tasks__list_*`, `mcp__kobo-tasks__read_document`, `mcp__kobo-tasks__search_codebase`, `mcp__kobo-tasks__get_*`) are fine; mutations (`mcp__kobo-tasks__mark_task_done`, `mcp__kobo-tasks__log_thought`, `mcp__kobo-tasks__set_workspace_status`) must wait until the plan is approved.',
  'Conventions — read these BEFORE starting work, not as a fallback:',
  '• `mcp__kobo-tasks__list_tasks` first on any non-trivial turn, then `mcp__kobo-tasks__mark_task_done` as each item completes.',
  '• `mcp__kobo-tasks__list_documents` / `mcp__kobo-tasks__read_document` to discover existing plans and specs under docs/ and .ai/thoughts/ before writing new ones.',
  '• `mcp__kobo-tasks__log_thought` to persist notable decisions to `.ai/thoughts/<date>-<slug>.md`.',
  '• `mcp__kobo-tasks__search_codebase` to recall prior chat history (conversations, not source — use shell tools for source).',
  '• `mcp__kobo-tasks__get_workspace_info` / `mcp__kobo-tasks__get_git_info` / `mcp__kobo-tasks__get_notion_ticket` for context.',
  '• `mcp__kobo-tasks__set_workspace_status` when the mission is done / blocked / idle.',
  '• `mcp__kobo-tasks__schedule_wakeup` / `mcp__kobo-tasks__cancel_wakeup` to schedule (or cancel) a follow-up session.',
  'Each tool carries its own "WHEN to use" guidance in its description — follow it.',
].join('\n')

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
      threadParams.sandbox = 'workspace-write'
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

  // Model: omit when undefined or 'auto', let Codex use its default
  if (input.model && input.model !== 'auto') {
    threadParams.model = input.model
  }

  // Effort: omit when undefined or 'auto'
  if (input.effort && input.effort !== 'auto') {
    threadParams.modelReasoningEffort = input.effort as ModelReasoningEffort
  }

  // `default_tools_approval_mode: 'auto'` pre-approves the namespace —
  // without it Codex blocks every MCP tool call with "user cancelled".
  if (input.mcpServers && input.mcpServers.length > 0) {
    type McpServerEntry = {
      command: string
      args: string[]
      env: Record<string, string>
      default_tools_approval_mode: string
    }
    const mcpServersConfig: Record<string, McpServerEntry> = {}
    for (const srv of input.mcpServers) {
      mcpServersConfig[srv.name] = {
        command: srv.command,
        args: srv.args,
        env: srv.env,
        default_tools_approval_mode: 'auto',
      }
    }
    threadParams.config = { mcp_servers: mcpServersConfig }
  }

  const effectivePrompt = isResume ? input.prompt : `${CODEX_KOBO_MCP_BRIEF}\n\n${input.prompt}`

  // Always emit collaborationMode — it's sticky server-side, so omitting it
  // would leave a resumed thread stuck in the previous turn's mode. Plan also
  // gates the `request_user_input` internal tool. Settings echo the resolved
  // model/effort because collaborationMode takes precedence over them.
  const collaborationMode: CollaborationMode = {
    mode: input.agentPermissionMode === 'plan' ? 'plan' : 'default',
    settings: {
      model: threadParams.model ?? 'auto',
      reasoning_effort: (threadParams.modelReasoningEffort as ModelReasoningEffort | undefined) ?? null,
      developer_instructions: null,
    },
  }

  return {
    threadParams,
    input: [{ type: 'text', text: effectivePrompt }],
    isResume,
    collaborationMode,
  }
}
