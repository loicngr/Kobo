import path from 'node:path'
import type { Workspace } from './workspace-service.js'

/** Variables available for substitution in a review prompt template. */
export interface ReviewTemplateContext {
  workspace: Workspace
  commits: string
  diffStats: string
  baseCommit: string
  additionalInstructions: string
}

export const DEFAULT_REVIEW_PROMPT_TEMPLATE = `You are reviewing code changes on workspace "{{workspace_name}}" in project {{project_name}}.

Branch: {{branch_name}}  (base: {{source_branch}})
Base commit: {{base_commit}}

If a code-review skill is available (e.g. superpowers:requesting-code-review), invoke it to drive this review. Otherwise follow the steps below directly.

## Scope

Review ALL changes — both committed and uncommitted in the working tree:
- \`git diff {{base_commit}}..HEAD\` — committed changes on this branch
- \`git status\` and \`git diff\` — uncommitted changes (staged + unstaged)

## Diff summary
{{diff_stats}}

## Commits
{{commits}}

## Additional instructions
{{additional_instructions}}

## Output

If no review skill is available, structure your reply as:
1. Summary — what changed and why
2. Issues — bugs, regressions, security or perf concerns (with file:line)
3. Suggestions — refactor / improvement opportunities
4. Tests — coverage gaps
5. Verdict — ship / fix-then-ship / blocked
`

function buildVariableMap(ctx: ReviewTemplateContext): Record<string, string> {
  return {
    project_name: path.basename(ctx.workspace.projectPath),
    workspace_name: ctx.workspace.name,
    branch_name: ctx.workspace.workingBranch,
    source_branch: ctx.workspace.sourceBranch,
    base_commit: ctx.baseCommit,
    commits: ctx.commits,
    diff_stats: ctx.diffStats,
    notion_url: ctx.workspace.notionUrl ?? '',
    additional_instructions: ctx.additionalInstructions.length > 0 ? ctx.additionalInstructions : '(none)',
  }
}

/**
 * Render a review prompt template by substituting {{variable}} placeholders.
 * Pure: no I/O, no side effects. Unknown variables are left intact.
 */
export function renderReviewTemplate(template: string, ctx: ReviewTemplateContext): string {
  const vars = buildVariableMap(ctx)
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    if (Object.hasOwn(vars, name)) {
      return vars[name]
    }
    return match
  })
}
