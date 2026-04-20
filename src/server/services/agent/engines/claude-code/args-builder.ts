export interface BuildClaudeArgsInput {
  prompt: string
  model?: string
  effort?: string
  permissionMode: 'auto-accept' | 'plan'
  skipPermissions: boolean
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
  if (input.skipPermissions) args.push('--dangerously-skip-permissions')

  let prompt = input.prompt

  // Only prepend the MCP brief on a fresh session — on --resume, the previous
  // turn's context already contains it, and re-prepending would spam.
  if (!input.resumeFromEngineSessionId) {
    prompt = `${KOBO_MCP_BRIEF}\n\n${prompt}`
  }

  if (input.permissionMode === 'plan') {
    prompt = `[PLAN MODE] You are in PLAN/READ-ONLY mode. You MUST NOT create, edit, write, or delete any files. Only use read-only tools (Read, Grep, Glob, LS, Bash for read-only commands). Analyze the codebase, plan your approach, and present your findings — but do NOT execute any changes.\n\n${prompt}`
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
