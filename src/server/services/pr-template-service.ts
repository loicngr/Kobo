import path from 'node:path'
import type { Task, Workspace } from './workspace-service.js'

export interface PrTemplateContext {
  workspace: Workspace
  prNumber: number
  prUrl: string
  commits: string
  diffStats: string
  tasks: Task[]
}

function formatTaskLine(t: Task): string {
  const mark = t.status === 'done' ? 'x' : ' '
  return `- [${mark}] ${t.title}`
}

function buildVariableMap(ctx: PrTemplateContext): Record<string, string> {
  const regularTasks = ctx.tasks.filter((t) => !t.isAcceptanceCriterion)
  const criteria = ctx.tasks.filter((t) => t.isAcceptanceCriterion)

  return {
    pr_number: String(ctx.prNumber),
    pr_url: ctx.prUrl,
    branch_name: ctx.workspace.workingBranch,
    source_branch: ctx.workspace.sourceBranch,
    workspace_name: ctx.workspace.name,
    project_name: path.basename(ctx.workspace.projectPath),
    notion_url: ctx.workspace.notionUrl ?? '',
    commits: ctx.commits,
    diff_stats: ctx.diffStats,
    tasks: regularTasks.map(formatTaskLine).join('\n'),
    acceptance_criteria: criteria.map(formatTaskLine).join('\n'),
  }
}

/**
 * Render a PR prompt template by substituting {{variable}} placeholders.
 *
 * Known variables are substituted from the context. Unknown variables are
 * left intact (useful for user-defined placeholders the agent may resolve
 * itself). The function is pure: no I/O, no side effects.
 */
export function renderPrTemplate(template: string, ctx: PrTemplateContext): string {
  const vars = buildVariableMap(ctx)
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    if (Object.hasOwn(vars, name)) {
      return vars[name]
    }
    return match // leave unknown variables as-is
  })
}
