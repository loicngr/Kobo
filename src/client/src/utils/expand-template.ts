import { WORKTREES_PATH } from '../../../shared/consts'

/** Variables that can be substituted into a prompt template at expansion time. */
export interface TemplateVars {
  // Workspace
  workspace_name?: string
  working_branch?: string
  source_branch?: string
  project_path?: string
  worktree_path?: string
  // Git
  commit_count?: number
  unpushed_count?: number
  files_changed?: number
  insertions?: number
  deletions?: number
  // PR
  pr_number?: number
  pr_url?: string
  pr_state?: 'OPEN' | 'CLOSED' | 'MERGED'
  // Session
  session_name?: string
}

/**
 * Expand `{variable_name}` placeholders in `content` using the provided `vars`.
 * Unknown or missing variables are left as-is (the placeholder stays visible
 * in the output so the user can see what would have been substituted).
 * Empty `{}` and unclosed `{incomplete` are not matched by the regex and pass
 * through unchanged.
 */
export function expandTemplate(content: string, vars: TemplateVars): string {
  return content.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = (vars as Record<string, unknown>)[key]
    if (value === undefined || value === null) return match
    return String(value)
  })
}

/**
 * Build the `TemplateVars` object from the current workspace store state.
 * Accepts a flat plain-object shape so the function has no Pinia dependency
 * and can be unit-tested trivially.
 */
export function buildTemplateVars(opts: {
  workspace: {
    name: string
    workingBranch: string
    sourceBranch: string
    projectPath: string
    worktreePath?: string | null
  } | null
  gitStats: {
    commitCount: number
    unpushedCount: number
    filesChanged: number
    insertions: number
    deletions: number
    prNumber?: number | null
    prUrl?: string | null
    prState?: 'OPEN' | 'CLOSED' | 'MERGED' | null
  } | null
  sessionName: string | null
}): TemplateVars {
  const vars: TemplateVars = {}
  if (opts.workspace) {
    vars.workspace_name = opts.workspace.name
    vars.working_branch = opts.workspace.workingBranch
    vars.source_branch = opts.workspace.sourceBranch
    vars.project_path = opts.workspace.projectPath
    vars.worktree_path =
      opts.workspace.worktreePath ?? `${opts.workspace.projectPath}/${WORKTREES_PATH}/${opts.workspace.workingBranch}`
  }
  if (opts.gitStats) {
    vars.commit_count = opts.gitStats.commitCount
    vars.unpushed_count = opts.gitStats.unpushedCount
    vars.files_changed = opts.gitStats.filesChanged
    vars.insertions = opts.gitStats.insertions
    vars.deletions = opts.gitStats.deletions
    if (opts.gitStats.prNumber != null) vars.pr_number = opts.gitStats.prNumber
    if (opts.gitStats.prUrl) vars.pr_url = opts.gitStats.prUrl
    if (opts.gitStats.prState) vars.pr_state = opts.gitStats.prState
  }
  if (opts.sessionName) vars.session_name = opts.sessionName
  return vars
}
