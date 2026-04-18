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

export function buildClaudeArgs(input: BuildClaudeArgsInput): BuildClaudeArgsResult {
  const args: string[] = ['--output-format', 'stream-json', '--verbose']
  if (input.skipPermissions) args.push('--dangerously-skip-permissions')

  let prompt = input.prompt
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
