/**
 * Permission profile for auto-accept mode:
 *
 * - `bypass` (default): emits `--dangerously-skip-permissions`. Maximum
 *   permissiveness, but the CLI internally hard-denies writes under
 *   `.claude/**` and `.github/workflows/**` regardless of the project's
 *   `settings.json` allow list.
 * - `strict`: emits `--permission-mode acceptEdits`. The CLI respects the
 *   project's `settings.json` allow/deny lists, so explicit allows for
 *   `.claude/**` or `.github/workflows/**` actually take effect. Bash / MCP
 *   calls outside the allow list will prompt and (absent a human) stall —
 *   only enable strict when the project has a well-curated allow list.
 */
export type PermissionProfile = 'bypass' | 'strict'

export interface BuildClaudeArgsInput {
  prompt: string
  model?: string
  effort?: string
  permissionMode: 'auto-accept' | 'plan'
  skipPermissions: boolean
  /** Optional — only relevant in `auto-accept` permissionMode. Defaults to `bypass`. */
  permissionProfile?: PermissionProfile
  resumeFromEngineSessionId?: string
  mcpConfigPath?: string
}

export interface BuildClaudeArgsResult {
  args: string[]
  /** The prompt after plan-mode prepending (caller may need this for logging). */
  effectivePrompt: string
}

/**
 * Short brief injected at the top of the first prompt of a *new* session so
 * the agent discovers the Kōbō MCP toolbox without having to be asked.
 * Skipped on `--resume` because the brief is already in conversation history.
 */
const KOBO_MCP_BRIEF = [
  '[Kōbō MCP] This workspace exposes a dedicated MCP server with tools prefixed `kobo__`.',
  "Non-interactive mode: this session runs via `claude -p`. Tools requiring a synchronous human reply (e.g. `AskUserQuestion`) won't complete — never call them. If you need user input, end the turn with a plain-text question; the user replies asynchronously via the chat UI.",
  'Plan mode: when running with `--permission-mode plan`, the read-only restriction applies to MCP tools too, not just built-ins. For Kōbō: `kobo__list_*`, `kobo__read_document`, `kobo__search_codebase`, `kobo__get_*` are fine; `kobo__mark_task_done`, `kobo__log_thought`, `kobo__set_workspace_status` are mutations and must wait until the plan is approved.',
  'Conventions — read these BEFORE starting work, not as a fallback:',
  '• `kobo__list_tasks` first on any non-trivial turn, then `kobo__mark_task_done` as each item completes.',
  '• `kobo__list_documents` / `kobo__read_document` to discover existing plans and specs under docs/ and .ai/thoughts/ before writing new ones.',
  '• `kobo__log_thought` to persist notable decisions to `.ai/thoughts/<date>-<slug>.md`.',
  '• `kobo__search_codebase` to recall prior chat history (conversations, not source — use Grep for source).',
  '• `kobo__get_workspace_info` / `kobo__get_git_info` / `kobo__get_notion_ticket` for context.',
  '• `kobo__set_workspace_status` when the mission is done / blocked / idle.',
  'Each tool carries its own "WHEN to use" guidance in its description — follow it.',
].join('\n')

export function buildClaudeArgs(input: BuildClaudeArgsInput): BuildClaudeArgsResult {
  const args: string[] = ['--output-format', 'stream-json', '--verbose']

  // `plan` mode is handled by Claude Code natively via `--permission-mode plan`.
  // Under plan mode, Claude restricts itself to read-only tools and surfaces an
  // `ExitPlanMode` tool call when the plan is ready for the user to approve.
  // `--dangerously-skip-permissions` is incompatible with plan mode (it would
  // bypass the very restriction plan mode enforces), so we skip it here.
  if (input.permissionMode === 'plan') {
    args.push('--permission-mode', 'plan')
  } else if (input.permissionProfile === 'strict') {
    // Strict profile: respect the project's settings.json allow/deny.
    // `acceptEdits` auto-accepts Edit/Write but enforces the allow list,
    // so `Edit(.claude/**)` and similar take effect (unlike in bypass mode).
    args.push('--permission-mode', 'acceptEdits')
  } else if (input.skipPermissions) {
    args.push('--dangerously-skip-permissions')
  }

  let prompt = input.prompt

  // Only prepend the MCP brief on a fresh session — on --resume, the previous
  // turn's context already contains it, and re-prepending would spam.
  if (!input.resumeFromEngineSessionId) {
    prompt = `${KOBO_MCP_BRIEF}\n\n${prompt}`
  }

  if (input.model && input.model !== 'auto') args.push('--model', input.model)
  if (input.effort && input.effort !== 'auto') args.push('--effort', input.effort)
  if (input.mcpConfigPath) args.push('--mcp-config', input.mcpConfigPath)

  if (input.resumeFromEngineSessionId) {
    args.push('--resume', input.resumeFromEngineSessionId, '-p', prompt)
  } else {
    args.push('-p', prompt)
  }

  return { args, effectivePrompt: prompt }
}
