import {
  AGNOSTIC_AUTO_LOOP_GROOMING_INTRO,
  AGNOSTIC_AUTO_LOOP_REVIEW_GATE,
  AGNOSTIC_BRAINSTORMING_INSTRUCTION,
  AGNOSTIC_QA_PROMPT_TEMPLATE,
  AGNOSTIC_REVIEW_TEMPLATE,
  GROOMING_INTRO_COMBINED,
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
  /** Instruction injected into the workspace bootstrap prompt — tells the
   *  agent HOW to brainstorm + plan before announcing `[BRAINSTORM_COMPLETE]`.
   *  Kept distinct from `reviewTemplate` because the brainstorming-phase
   *  workflow is suite-specific (e.g. superpowers:brainstorming →
   *  superpowers:writing-plans for one suite, /office-hours → /autoplan
   *  for another). */
  brainstormingInstruction: string
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
  brainstormingInstruction:
    'Brainstorm the implementation approach with discipline:\n' +
    '1. Use the `superpowers:brainstorming` skill — it walks you through purpose, requirements, and design BEFORE any code. Ask clarifying questions and wait for explicit user approval on the design before moving on.\n' +
    '2. Use `superpowers:writing-plans` to turn the approved design into a multi-step implementation plan, saved under `docs/superpowers/plans/`.\n' +
    '3. If you encounter a bug or unexpected behaviour during exploration, use `superpowers:systematic-debugging` rather than guessing.\n' +
    "Do NOT skip the skills or rationalise around them — that's how the rigour gets lost.",
}

export const GSTACK_PROMPTS: SuitePrompts = {
  reviewTemplate:
    REVIEW_HEADER +
    'Run /review to drive this audit (the gstack Staff Engineer skill — finds bugs that pass CI but blow up in production, auto-fixes the obvious ones, flags completeness gaps). If /review is unavailable in this environment, fall back to the manual checklist below.\n\n' +
    REVIEW_BODY,
  autoLoopReviewGate:
    'Code review gate — BEFORE marking the task done, run /review (the gstack Staff Engineer skill). Brief it with: what you just implemented, the task title, and the commit SHA (via `git rev-parse HEAD`). Ask specifically whether the change matches the task scope, whether edge cases are handled, and whether the commit is clean. If /review auto-fixes minor issues, accept the fixes via an amend or fix-up commit, then re-run step 3 checks.',
  autoLoopGroomingIntro: GROOMING_INTRO_GSTACK,
  qaPromptTemplate: `QA pass for workspace "{{workspace_name}}" in project {{project_name}}.

Branch: {{branch_name}}
Staging URL: {{staging_url}}

Pick the right gstack tool for the situation:

- \`/browse\` — Headless navigation: URL → interactions → screenshots. Use for quick dogfooding a flow or sanity-checking a PR.
- \`/qa {{staging_url}}\` — Systematic QA with automatic bug fixing. Three tiers (invoke as \`/qa Quick\`, \`/qa Standard\`, or \`/qa Exhaustive\`):
  - **Quick** — critical and high-severity bugs only.
  - **Standard** — adds medium-severity bugs.
  - **Exhaustive** — adds cosmetic issues.
- \`/qa-only {{staging_url}}\` — Same methodology as \`/qa\` but report only, no code changes. Use when you only want a bug report.
- \`/design-review\` — Visual audit (consistency, spacing, hierarchy, AI slop). Commits atomic fixes with before/after screenshots.

For reproducible regression coverage that runs on every PR, prefer **Cypress** specs in \`test/cypress/\` instead of \`/qa\`. Reserve the gstack tools above for exploration, dogfooding, and one-shot visual debugging.`,
  brainstormingInstruction:
    'Brainstorm the implementation approach using the gstack sprint pipeline:\n' +
    '1. Run `/office-hours` — six forcing questions that reframe the problem and write a design doc. This is where you challenge premises and surface alternatives before any code.\n' +
    '2. Run `/autoplan` — it chains CEO → design → eng → DX reviews automatically (auto-detects which apply) and surfaces only the taste decisions you need to approve. Prefer this over manual orchestration.\n' +
    '3. If you need fine control (e.g. skip a step, run one in isolation), invoke the individual skills instead: `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/plan-devex-review`.\n' +
    '4. Wait for explicit user approval on the final plan before announcing brainstorming is done.',
}

export const AGNOSTIC_PROMPTS: SuitePrompts = {
  reviewTemplate: AGNOSTIC_REVIEW_TEMPLATE,
  autoLoopReviewGate: AGNOSTIC_AUTO_LOOP_REVIEW_GATE,
  autoLoopGroomingIntro: AGNOSTIC_AUTO_LOOP_GROOMING_INTRO,
  qaPromptTemplate: AGNOSTIC_QA_PROMPT_TEMPLATE,
  brainstormingInstruction: AGNOSTIC_BRAINSTORMING_INSTRUCTION,
}

// ── Combined: superpowers + gstack ────────────────────────────────────────────
// For users who install BOTH suites and want prompts that surface each suite's
// strengths. Specialised by intent, not "use whichever is available":
//   - /review (gstack)               → tactical code-level bug-hunting + auto-fix
//   - superpowers:requesting-code-review → principles-level critique (silent
//     failures, surface-area discipline, test-design soundness)
//   - /qa, /design-review, /browse   → interactive QA (gstack only)
//   - superpowers-chrome:browsing    → low-level browser control fallback

export const COMBINED_PROMPTS: SuitePrompts = {
  reviewTemplate:
    REVIEW_HEADER +
    'Two complementary review skills are available — pick by intent:\n' +
    '- `/review` (gstack Staff Engineer) for tactical bug-hunting that finds issues passing CI but blowing up in production. Auto-fixes the obvious ones.\n' +
    '- `superpowers:requesting-code-review` for principles-level critique — silent failures, test-design soundness, surface-area discipline.\n' +
    'You can run both on the same diff if the change is large. If neither is available, fall back to the manual checklist below.\n\n' +
    REVIEW_BODY,
  autoLoopReviewGate:
    'Code review gate — BEFORE marking the task done, pick the appropriate review skill (two are installed):\n' +
    '- Default to `/review` (gstack Staff Engineer) for tactical code-level bugs and auto-fixes.\n' +
    '- Use `superpowers:requesting-code-review` instead when the task introduces tests, refactors, or design decisions worth a principles-level critique.\n\n' +
    'Brief the chosen reviewer with: what you just implemented, the task title, and the commit SHA (via `git rev-parse HEAD`). Ask specifically whether the change matches the task scope, whether edge cases are handled, and whether the commit is clean. If the reviewer auto-fixes minor issues, accept the fixes via an amend or fix-up commit, then re-run step 3 checks.',
  autoLoopGroomingIntro: GROOMING_INTRO_COMBINED,
  qaPromptTemplate: `QA pass for workspace "{{workspace_name}}" in project {{project_name}}.

Branch: {{branch_name}}
Staging URL: {{staging_url}}

Pick the right tool for the situation. gstack covers interactive QA; superpowers covers low-level browser control as a fallback.

gstack QA toolkit (preferred for interactive QA):
- \`/browse\` — Headless navigation: URL → interactions → screenshots. Use for quick dogfooding a flow or sanity-checking a PR.
- \`/qa {{staging_url}}\` — Systematic QA with automatic bug fixing. Three tiers (invoke as \`/qa Quick\`, \`/qa Standard\`, or \`/qa Exhaustive\`):
  - **Quick** — critical and high-severity bugs only.
  - **Standard** — adds medium-severity bugs.
  - **Exhaustive** — adds cosmetic issues.
- \`/qa-only {{staging_url}}\` — Same methodology as \`/qa\` but report only, no code changes.
- \`/design-review\` — Visual audit (consistency, spacing, hierarchy, AI slop). Commits atomic fixes with before/after screenshots.

Superpowers alternative (low-level browser control):
- \`superpowers-chrome:browsing\` — Direct Chrome DevTools Protocol control over an existing Chrome session: multi-tab management, form automation, content extraction. Use when you need fine-grained control beyond what \`/browse\` exposes.

For reproducible regression coverage that runs on every PR, prefer **Cypress** specs in \`test/cypress/\` instead of any interactive QA skill. Reserve the tools above for exploration, dogfooding, and one-shot visual debugging.`,
  brainstormingInstruction:
    'Brainstorm using both suites — each plays to its strength:\n' +
    '1. Early product framing: prefer gstack `/office-hours` for product-shaped work (six forcing questions + design doc). Fall back to `superpowers:brainstorming` for purely infra/refactor work where the product lens does not apply.\n' +
    '2. Plan construction: prefer gstack `/autoplan` for the chained CEO/design/eng/DX pipeline. Use `superpowers:writing-plans` instead when you need a TDD-shaped multi-step plan that maps cleanly onto subagent dispatch.\n' +
    '3. If you need fine control on either side, invoke the individual skills explicitly (`/plan-ceo-review`, `/plan-eng-review`, …) or stay with the superpowers brainstorm flow.\n' +
    '4. For debugging during exploration, prefer `/investigate` (gstack — root-cause methodology) or `superpowers:systematic-debugging`, whichever you reach for first.\n' +
    '5. Wait for explicit user approval on the final plan before announcing brainstorming is done.',
}

/**
 * Resolve the suite prompts to use right now, given the global `skillSuite`
 * and the four user-editable `custom*` fields (only consulted in `custom` mode).
 * Empty-string or whitespace-only overrides fall back to AGNOSTIC defaults.
 */
export function getSuitePrompts(suite: SkillSuite, overrides: Partial<SuitePrompts>): SuitePrompts {
  if (suite === 'superpowers') return SUPERPOWERS_PROMPTS
  if (suite === 'gstack') return GSTACK_PROMPTS
  if (suite === 'superpowers+gstack') return COMBINED_PROMPTS
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
    brainstormingInstruction: pick('brainstormingInstruction'),
  }
}
