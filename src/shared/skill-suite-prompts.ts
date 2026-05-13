// src/shared/skill-suite-prompts.ts

/**
 * Skill suite identifier — selects which skill ecosystem Kōbō's
 * auto-generated prompts reference.
 *
 * - `superpowers`: prompts cite `superpowers:*` skills (default for new and
 *    migrated installs).
 * - `gstack`: prompts cite gstack slash commands (`/review`, `/ship`, `/qa`, …).
 * - `custom`: prompts come from the user-editable `custom*` fields in settings,
 *    initialised to the AGNOSTIC defaults below.
 */
export type SkillSuite = 'superpowers' | 'gstack' | 'custom'

export function isValidSkillSuite(value: unknown): value is SkillSuite {
  return value === 'superpowers' || value === 'gstack' || value === 'custom'
}

// ── Agnostic prompt strings ───────────────────────────────────────────────────
// These are the neutral, suite-free versions used both:
//   1. As the seed for `custom` mode (so the user has a sane base to edit).
//   2. As building blocks for the backend full prompt sets in
//      `src/server/services/skill-suite-prompts.ts`.
//
// They MUST NOT mention any specific skill suite by name.

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

export const AGNOSTIC_REVIEW_TEMPLATE =
  REVIEW_HEADER +
  'If a code-review skill is available in this environment, invoke it to drive this audit. Otherwise follow the manual checklist below.\n\n' +
  REVIEW_BODY

export const AGNOSTIC_AUTO_LOOP_REVIEW_GATE =
  'Code review gate — BEFORE marking the task done, run whichever code-review skill is configured in this environment. Brief it with: what you just implemented, the task title, and the commit SHA (via `git rev-parse HEAD`). Ask specifically whether the change matches the task scope, whether edge cases are handled, and whether the commit is clean. If no review skill is available, do a manual self-review against the same criteria.'

export const AGNOSTIC_AUTO_LOOP_GROOMING_INTRO =
  'You are preparing this workspace for Kōbō auto-loop mode. This is a GROOMING session only — DO NOT implement anything, DO NOT write or edit code, DO NOT run tests or builds, DO NOT invoke any implementation, planning, or release skill (your environment may have several). Your ONLY job is to curate the Kōbō task list via MCP tools.'

export const AGNOSTIC_QA_PROMPT_TEMPLATE =
  'QA pass for workspace "{{workspace_name}}" in project {{project_name}}.\n\nBranch: {{branch_name}}\nStaging URL: {{staging_url}}\n\nIf a QA skill is configured in this environment, invoke it on {{staging_url}}. Otherwise, manually exercise the staging URL against the workspace\'s acceptance criteria and report findings.'

// ── Grooming intro: superpowers + gstack variants ────────────────────────────
// Only the grooming intro is needed shared (both backend auto-loop-prompts and
// frontend kobo-commands use it). The review/review-gate/QA variants are
// backend-only — they live in src/server/services/skill-suite-prompts.ts.

export const GROOMING_INTRO_SUPERPOWERS =
  'You are preparing this workspace for Kōbō auto-loop mode. This is a GROOMING session only — DO NOT implement anything, DO NOT write or edit code, DO NOT run tests or builds, DO NOT invoke `superpowers:executing-plans` or any implementation skill. Your ONLY job is to curate the Kōbō task list via MCP tools.'

export const GROOMING_INTRO_GSTACK =
  'You are preparing this workspace for Kōbō auto-loop mode. This is a GROOMING session only — DO NOT implement anything, DO NOT write or edit code, DO NOT run tests or builds, DO NOT invoke `/ship`, `/autoplan`, `/land-and-deploy`, or any implementation skill. Your ONLY job is to curate the Kōbō task list via MCP tools.'

/**
 * Resolve the grooming intro for the given suite. In `custom` mode, the
 * user-provided override is used (or AGNOSTIC if the override is empty/blank).
 */
export function getGroomingIntro(suite: SkillSuite, customOverride?: string): string {
  if (suite === 'custom') {
    const trimmed = (customOverride ?? '').trim()
    return trimmed || AGNOSTIC_AUTO_LOOP_GROOMING_INTRO
  }
  if (suite === 'gstack') return GROOMING_INTRO_GSTACK
  return GROOMING_INTRO_SUPERPOWERS
}
