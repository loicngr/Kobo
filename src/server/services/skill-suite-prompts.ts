import {
  AGNOSTIC_AUTO_LOOP_GROOMING_INTRO,
  AGNOSTIC_AUTO_LOOP_REVIEW_GATE,
  AGNOSTIC_QA_PROMPT_TEMPLATE,
  AGNOSTIC_REVIEW_TEMPLATE,
  GROOMING_INTRO_GSTACK,
  GROOMING_INTRO_SUPERPOWERS,
  type SkillSuite,
} from '../../shared/skill-suite-prompts.js'

export type { SkillSuite } from '../../shared/skill-suite-prompts.js'

export interface SuitePrompts {
  /** Review template — placeholders: {{workspace_name}}, {{project_name}},
   *  {{branch_name}}, {{source_branch}}, {{base_commit}}, {{diff_stats}},
   *  {{commits}}, {{additional_instructions}}. */
  reviewTemplate: string
  /** Inserted as step 6 of the auto-loop iteration prompt. */
  autoLoopReviewGate: string
  /** Top of the auto-loop grooming session. */
  autoLoopGroomingIntro: string
  /** Template for QA pass. Placeholders: {{workspace_name}}, {{project_name}},
   *  {{branch_name}}, {{staging_url}}. Not auto-invoked anywhere. */
  qaPromptTemplate: string
}

// Headers and body shared with the agnostic baseline. We reconstruct them
// locally here so the suite-specific text can sit between header and body
// in the same shape across all 3 suites.
const REVIEW_HEADER = `You are reviewing code changes on workspace "{{workspace_name}}" in project {{project_name}}.

Branch: {{branch_name}}  (base: {{source_branch}})
Base commit: {{base_commit}}

`

const REVIEW_BODY = `## Scope

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

export const SUPERPOWERS_PROMPTS: SuitePrompts = {
  reviewTemplate:
    REVIEW_HEADER +
    'If a code-review skill is available (e.g. superpowers:requesting-code-review), invoke it to drive this review. Otherwise follow the steps below directly.\n\n' +
    REVIEW_BODY,
  autoLoopReviewGate:
    'Code review gate — BEFORE marking the task done, dispatch an independent code-reviewer subagent via the Task tool with `subagent_type: "code-reviewer"` (or `"superpowers:code-reviewer"` / `"pr-review-toolkit:code-reviewer"` — use whichever exists in this environment; fall back to `superpowers:requesting-code-review` skill if none is available). Brief the reviewer with: what you just implemented, the task title, and the commit SHA (via `git rev-parse HEAD`). Ask specifically whether the change matches the task scope, whether edge cases are handled, and whether the commit is clean.',
  autoLoopGroomingIntro: GROOMING_INTRO_SUPERPOWERS,
  qaPromptTemplate:
    'QA pass for workspace "{{workspace_name}}" in project {{project_name}}.\n\nBranch: {{branch_name}}\nStaging URL: {{staging_url}}\n\nIf a QA-style skill that drives a real browser is available in this environment (e.g. via the superpowers-chrome browsing skill), use it to navigate the staging URL and exercise the changes. Otherwise, fall back to manually scripting the smoke checks and recording your findings as a bug report.',
}

export const GSTACK_PROMPTS: SuitePrompts = {
  reviewTemplate:
    REVIEW_HEADER +
    'Run /review to drive this audit (the gstack Staff Engineer skill — finds bugs that pass CI but blow up in production, auto-fixes the obvious ones, flags completeness gaps). If /review is unavailable in this environment, fall back to the manual checklist below.\n\n' +
    REVIEW_BODY,
  autoLoopReviewGate:
    'Code review gate — BEFORE marking the task done, run /review (the gstack Staff Engineer skill). Brief it with: what you just implemented, the task title, and the commit SHA (via `git rev-parse HEAD`). Ask specifically whether the change matches the task scope, whether edge cases are handled, and whether the commit is clean. If /review auto-fixes minor issues, accept the fixes via an amend or fix-up commit, then re-run step 3 checks.',
  autoLoopGroomingIntro: GROOMING_INTRO_GSTACK,
  qaPromptTemplate:
    'QA pass for workspace "{{workspace_name}}" in project {{project_name}}.\n\nBranch: {{branch_name}}\nStaging URL: {{staging_url}}\n\nRun /qa {{staging_url}} (gstack QA Lead skill — opens a real browser, clicks through flows, finds bugs, fixes them with atomic commits, generates regression tests). If you only want a bug report without code changes, use /qa-only {{staging_url}} instead.',
}

export const AGNOSTIC_PROMPTS: SuitePrompts = {
  reviewTemplate: AGNOSTIC_REVIEW_TEMPLATE,
  autoLoopReviewGate: AGNOSTIC_AUTO_LOOP_REVIEW_GATE,
  autoLoopGroomingIntro: AGNOSTIC_AUTO_LOOP_GROOMING_INTRO,
  qaPromptTemplate: AGNOSTIC_QA_PROMPT_TEMPLATE,
}

/**
 * Resolve the suite prompts to use right now, given the global `skillSuite`
 * and the four user-editable `custom*` fields (only consulted in `custom` mode).
 * Empty-string or whitespace-only overrides fall back to AGNOSTIC defaults.
 */
export function getSuitePrompts(suite: SkillSuite, overrides: Partial<SuitePrompts>): SuitePrompts {
  if (suite === 'superpowers') return SUPERPOWERS_PROMPTS
  if (suite === 'gstack') return GSTACK_PROMPTS
  // custom mode: per-field fallback to AGNOSTIC when the override is missing/blank
  const pick = <K extends keyof SuitePrompts>(k: K): string => {
    const value = overrides[k]
    if (typeof value !== 'string') return AGNOSTIC_PROMPTS[k]
    return value.trim() ? value : AGNOSTIC_PROMPTS[k]
  }
  return {
    reviewTemplate: pick('reviewTemplate'),
    autoLoopReviewGate: pick('autoLoopReviewGate'),
    autoLoopGroomingIntro: pick('autoLoopGroomingIntro'),
    qaPromptTemplate: pick('qaPromptTemplate'),
  }
}
