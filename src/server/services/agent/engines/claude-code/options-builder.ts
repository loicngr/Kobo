import type { CanUseTool, Options } from '@anthropic-ai/claude-agent-sdk'

export type AgentPermissionMode = 'plan' | 'bypass' | 'strict' | 'interactive'

export interface BuildClaudeOptionsInput {
  prompt: string
  model?: string
  effort?: string
  /** Unified SDK-aligned permission mode (plan | bypass | strict | interactive). */
  agentPermissionMode: AgentPermissionMode
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
}

const KOBO_MCP_BRIEF = [
  '[Kōbō MCP] This workspace exposes a dedicated MCP server with tools prefixed `kobo__`.',
  'Non-interactive mode: this session runs via the Claude Agent SDK in single-shot mode. To ask the user a question, call the `AskUserQuestion` tool — Kōbō will pause the session, collect the answer asynchronously, and resume.',
  '⚠️ HARD RULE — emit AT MOST ONE `AskUserQuestion` tool call per turn, and emit it ALONE (no other tool calls in the same response). The Claude Agent SDK rejects parallel defers: a second `AskUserQuestion` in the same turn breaks the pause mechanism, makes both calls fail with "AskUserQuestion fails", and the user sees the panel arrive only at the end of the turn (if at all). If you have N questions, group them as a multi-question array inside ONE call: `AskUserQuestion({ questions: [{ question: "Q1", options: [...] }, { question: "Q2", options: [...] }] })`. After invoking it, STOP — do not emit any other tool call. Wait for the resume.',
  'Plan mode: when running with `permissionMode: plan`, the read-only restriction applies to MCP tools too. For Kōbō: `kobo__list_*`, `kobo__read_document`, `kobo__search_codebase`, `kobo__get_*` are fine; `kobo__mark_task_done`, `kobo__log_thought`, `kobo__set_workspace_status` are mutations and must wait until the plan is approved.',
  'Conventions — read these BEFORE starting work, not as a fallback:',
  '• `kobo__list_tasks` first on any non-trivial turn, then `kobo__mark_task_done` as each item completes.',
  '• `kobo__list_documents` / `kobo__read_document` to discover existing plans and specs under docs/ and .ai/thoughts/ before writing new ones.',
  '• `kobo__log_thought` to persist notable decisions to `.ai/thoughts/logs/<date>-<slug>.md`.',
  '• `kobo__search_codebase` to recall prior chat history (conversations, not source — use Grep for source).',
  '• `kobo__read_workspace_events_csv` to read paginated user/agent history from this workspace across sessions when prior context is useful. Use `limit` + `offset` (and optional `session_id`) instead of loading everything.',
  '• `kobo__get_workspace_info` / `kobo__get_git_info` / `kobo__get_ticket` for context.',
  '• `kobo__set_workspace_status` when the mission is done or irrecoverably blocked. Never set `idle` while this session is active; use AskUserQuestion for clarification, or end the turn.',
  '• `kobo__schedule_wakeup` / `kobo__cancel_wakeup` to schedule (or cancel) a follow-up session — prefer these over the built-in `ScheduleWakeup` tool.',
  'Each tool carries its own "WHEN to use" guidance in its description — follow it.',
].join('\n')

/**
 * Appended to the Claude Code preset system prompt so the rule is always in
 * context (not just the first turn like KOBO_MCP_BRIEF). Teaches the agent to
 * survive long-running work via `kobo__schedule_wakeup` instead of stalling the
 * session — the recurring "tell it how to stay alive" friction.
 */
const KOBO_SYSTEM_APPEND = [
  '[Kōbō] Surviving long waits — when a task takes more than ~1-2 min (test suites, CI, builds, deploys, waiting on external state): never block your turn with sleep/poll loops, and never end a turn merely "waiting" on a background job — the Kōbō session goes idle and will NOT resume itself, so the work stalls.',
  'Instead: launch it in the background (redirect output to a log file), call `kobo__schedule_wakeup` with `delaySeconds` ≈ the expected duration and a `prompt` telling future-you exactly what to check (the log path + next step), then end the turn. On wakeup: inspect the result, call `kobo__cancel_wakeup` if it finished early, and continue. Do this proactively, without being asked.',
].join('\n')

export function buildClaudeOptions(input: BuildClaudeOptionsInput): BuildClaudeOptionsResult {
  const options: Options = {
    cwd: input.workingDir,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: KOBO_SYSTEM_APPEND },
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

  let prompt = input.prompt
  if (!input.resumeFromEngineSessionId) {
    prompt = `${KOBO_MCP_BRIEF}\n\n${prompt}`
  }

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

  return { options, effectivePrompt: prompt }
}
