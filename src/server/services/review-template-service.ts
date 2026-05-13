import path from 'node:path'
import { getGlobalSettings } from './settings-service.js'
import { getSuitePrompts, SUPERPOWERS_PROMPTS } from './skill-suite-prompts.js'
import type { Workspace } from './workspace-service.js'

/** Variables available for substitution in a review prompt template. */
export interface ReviewTemplateContext {
  workspace: Workspace
  commits: string
  diffStats: string
  baseCommit: string
  additionalInstructions: string
}

/**
 * Back-compat alias for the legacy review-template default. The canonical
 * default now lives in `SUPERPOWERS_PROMPTS.reviewTemplate`; this export is
 * kept so existing seed/migration paths in `settings-service.ts` and
 * `routes/settings.ts` (the "reset to default" endpoint) keep working
 * without being rewritten. Runtime readers should call
 * `getActiveReviewTemplate()` instead, which respects the user's
 * `skillSuite` choice.
 */
export const DEFAULT_REVIEW_PROMPT_TEMPLATE: string = SUPERPOWERS_PROMPTS.reviewTemplate

/**
 * Resolve the review prompt template active for this user right now:
 * read the global `skillSuite` and, in `custom` mode, the
 * `customReviewTemplate` override. On the default `superpowers` suite this
 * returns the same text as the legacy `DEFAULT_REVIEW_PROMPT_TEMPLATE`.
 */
export function getActiveReviewTemplate(): string {
  const global = getGlobalSettings()
  return getSuitePrompts(global.skillSuite, {
    reviewTemplate: global.customReviewTemplate,
  }).reviewTemplate
}

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
