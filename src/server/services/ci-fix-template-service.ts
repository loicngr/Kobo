import path from 'node:path'
import type { Workspace } from './workspace-service.js'

/** A single failed CI check as surfaced by the forge provider. */
export interface CiFixCheck {
  name: string
  detailsUrl: string | null
}

/** Variables available for substitution in a CI-fix prompt template. */
export interface CiFixTemplateContext {
  workspace: Workspace
  prNumber: number | null
  prUrl: string | null
  prTitle: string | null
  failedChecks: CiFixCheck[]
  ciRunUrl: string | null
}

function formatFailedJobs(checks: CiFixCheck[]): string {
  if (checks.length === 0) return '(no failed jobs reported)'
  return checks.map((c) => (c.detailsUrl ? `- ${c.name} — ${c.detailsUrl}` : `- ${c.name}`)).join('\n')
}

function buildVariableMap(ctx: CiFixTemplateContext): Record<string, string> {
  return {
    pr_number: ctx.prNumber != null ? String(ctx.prNumber) : '',
    pr_url: ctx.prUrl ?? '',
    pr_title: ctx.prTitle ?? '',
    branch_name: ctx.workspace.workingBranch,
    source_branch: ctx.workspace.sourceBranch,
    workspace_name: ctx.workspace.name,
    workspace_id: ctx.workspace.id,
    project_name: path.basename(ctx.workspace.projectPath),
    failed_jobs: formatFailedJobs(ctx.failedChecks),
    ci_run_url: ctx.ciRunUrl ?? '',
  }
}

/**
 * Render a CI-fix prompt template by substituting {{variable}} placeholders.
 * Pure function — no I/O. Unknown variables are left as-is so user-defined
 * placeholders can be resolved downstream by the agent itself.
 */
export function renderCiFixTemplate(template: string, ctx: CiFixTemplateContext): string {
  const vars = buildVariableMap(ctx)
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    if (Object.hasOwn(vars, name)) {
      return vars[name]
    }
    return match
  })
}
