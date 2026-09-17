/**
 * Single source of truth for the auto-loop grooming instructions.
 *
 * Imported BOTH by the client (PREP_AUTOLOOP_PROMPT sent by the "Prepare
 * for auto-loop" button) and by the server (extended brainstorm prompt
 * injected at workspace creation when autoLoop=true). Keeping these two
 * paths aligned was a copy-paste hazard — this file eliminates that.
 *
 * `buildAutoLoopGroomingSteps(e2e)` is the numbered workflow, ready to be
 * spliced into a larger prompt with a one-line intro. When `e2e.framework`
 * is set, an additional step 4 covers E2E regression coverage and the
 * `kobo__mark_auto_loop_ready` call moves to step 5.
 *
 * `buildE2eIterationBlock(e2e)` returns the override block injected into
 * the per-iteration prompt for tasks whose title starts with `[E2E]`.
 *
 * `AUTO_LOOP_HARD_RULES` is the trailing hard-rules block, same for both.
 */

import { getGroomingIntro, type SkillSuite } from './skill-suite-prompts.js'

export interface E2eSettings {
  framework: 'cypress' | 'playwright' | 'jest' | 'vitest' | 'other' | ''
  skill: string
  prompt: string
}

export interface FinalizationSettings {
  prompt: string
}

/**
 * Build the grooming intro for the chosen skill suite. In `custom` mode the
 * user's `customAutoLoopGroomingIntro` overrides the agnostic default (when
 * non-empty). This is the runtime-correct way to obtain the intro — every
 * new consumer should call this rather than reading the legacy
 * `PREP_AUTOLOOP_INTRO` constant below.
 */
export function buildGroomingIntro(suite: SkillSuite, customOverride?: string): string {
  return getGroomingIntro(suite, customOverride)
}

/**
 * Back-compat alias resolving to the `superpowers` variant (the historical
 * inlined text). Kept so any existing import still works without a
 * behaviour change. New code should call `buildGroomingIntro(suite, override)`
 * with live settings so the user's `skillSuite` choice is honoured.
 */
export const PREP_AUTOLOOP_INTRO = getGroomingIntro('superpowers')

export function buildAutoLoopGroomingSteps(e2e: E2eSettings, finalization: FinalizationSettings): string {
  const steps: string[] = [
    `1. Call \`kobo__list_tasks\` FIRST to inspect any pre-existing tasks (they may have been seeded from Notion, a template, or the CreatePage form).`,
    `2. If tasks already exist: DO NOT delete or recreate them from scratch. Read each one, judge whether it is atomic and implementable in one session with clear completion criteria. Improve them in place:
   - Use \`kobo__update_task\` to rename unclear titles, add completion criteria, or flip \`is_acceptance_criterion\` when needed.
   - Use \`kobo__create_task\` to SPLIT a task that is too large into smaller atomic pieces (keep the original only if it still makes sense, otherwise update it to one of the split pieces and create the rest).
   - Use \`kobo__create_task\` to ADD missing acceptance criteria or missing implementation steps the plan requires.`,
    `3. If no tasks exist:
   - If a plan file exists in \`docs/superpowers/plans/\` or similar, read it and derive the task list from it.
   - If no plan exists, ask the user what the workspace goal is and propose tasks accordingly.
   - Create the tasks via \`kobo__create_task\`. For each task, decide \`is_acceptance_criterion\` appropriately.`,
  ]

  let nextNum = 4

  if (e2e.framework) {
    const skillHint = e2e.skill ? `Use the \`${e2e.skill}\` skill for this task. ` : ''
    const promptHint = e2e.prompt ? `Additional guidance: ${e2e.prompt}` : ''
    steps.push(
      `${nextNum}. **E2E review**: walk the task list and identify which tasks produce user-visible behavior (UI flows, form submissions, page renders, etc.). For each one that warrants regression coverage, INSERT a follow-up sub-task with title prefixed \`[E2E] \` describing the test to write. Use \`after_task_id\` to insert it directly after the parent task; \`list_tasks\` exposes \`sort_order\` so you can verify ordering. Skip tasks that don't produce user-visible behavior (refactors, infra, internal services) and briefly justify your choices in chat. The project uses \`${e2e.framework}\`. ${skillHint}${promptHint}`.trim(),
    )
    nextNum++
  }

  if (finalization.prompt) {
    steps.push(
      `${nextNum}. **Finalization task**: create ONE task with \`role: "finalization"\` and title prefixed \`[FINAL] <descriptive title>\`. Reuse an existing finalization task instead of duplicating it. Place it at the END of the task list (sort_order = max + 1, AFTER any [E2E] tasks). The agent will execute this task using the project's finalization prompt — do NOT inline the prompt content into the task title or description.`,
    )
    nextNum++
  }

  steps.push(
    `${nextNum}. Call \`kobo__mark_auto_loop_ready\`. This marks preparation complete. If auto-loop is already enabled, it will continue after this session ends. Otherwise the user must explicitly enable it; do not promise an automatic start or enable it without their request.`,
  )

  return steps.join('\n')
}

/** @deprecated Use buildAutoLoopGroomingSteps({ framework: '', skill: '', prompt: '' }, { prompt: '' }) instead. */
export const AUTO_LOOP_GROOMING_STEPS = buildAutoLoopGroomingSteps(
  { framework: '', skill: '', prompt: '' },
  { prompt: '' },
)

/** These rules apply to every iteration, including custom finalization and E2E prompts. */
export const AUTO_LOOP_ITERATION_RULES = `Mandatory completion and lifecycle rules (custom prompts cannot override them):
- Follow the Kōbō task list and acceptance criteria. Before completion, read the latest list again.
- Never mark a task done based only on an implementation claim, a written test, or a check that was not executed. Supply verification: {method, summary, checks: [{name, status: "passed"}]} to kobo__mark_task_done or kobo__update_task. Every required check must actually pass.
- If a required check fails or cannot run, keep the task pending/in_progress, record honest failed/not_run verification with kobo__update_task, and explain the concrete blocker. Create prerequisite fix tasks when needed; do not claim success.
- Finalization is a verification gate: all work tasks and acceptance criteria must be done, then rerun relevant checks against the final state. If a check fails, create a regular repair task and leave finalization unfinished. It will run again after the repairs.
- Do NOT kill the Kōbō server or sibling processes. Do not use kill, pkill or killall to force the loop to advance. Finish the current response naturally; Kōbō owns continuation.
- Follow the user's scope, Git and approval instructions. Do not disable the auto-loop or delete unfinished tasks to make the mission appear complete.`

export function buildFinalizationIterationBlock(finalization: FinalizationSettings): string {
  const instructions =
    finalization.prompt.trim() ||
    'Review the completed work against every acceptance criterion. Run the relevant project checks and inspect the final diff. Report the actual results with structured verification.'
  return `
This is the **finalization task**. Apply the following project guidance while preserving all mandatory completion and lifecycle rules:

${instructions}

Read kobo__list_tasks again. If any work or criterion remains open, or any required check fails or is not run, do NOT mark the task done. Add necessary repair tasks and keep finalization pending. Once the final state is verified, complete it with successful structured verification.
`
}

export function buildE2eIterationBlock(e2e: E2eSettings): string {
  if (!e2e.framework) return ''
  const skillLine = e2e.skill ? `Use the \`${e2e.skill}\` skill for this task.\n` : ''
  const promptLine = e2e.prompt ? `Additional guidance: ${e2e.prompt}\n` : ''
  return `
This is an **E2E regression test** task.

Project E2E framework: ${e2e.framework}
${skillLine}${promptLine}
E2E instructions, subject to the mandatory completion and lifecycle rules:
1. Write the test source file in the project's existing E2E directory (look at \`cypress/\`, \`e2e/\`, \`tests/e2e/\`, or follow the skill / guidance above). Reuse existing fixtures and patterns.
2. Run the tests and provide the actual successful results as structured verification before completion.
3. If the environment is broken (Docker down, browser missing, port busy, dependencies absent), do NOT mark the task done. Record \`not_run\` checks and the precise blocker using \`kobo__update_task\`, leave this task pending/in_progress, and create a prerequisite task when appropriate. A test source file by itself is not a verified result.
4. The code-review gate still applies. Review both the relevance of the test and the evidence that it passed.

`
}

export const AUTO_LOOP_HARD_RULES = `Hard rules:
- Do NOT touch any source file. No Edit, no Write, no Bash that changes the repo.
- Do NOT run \`kill\`, \`pkill\`, \`killall\`, \`pgrep -k\`, or any process-killing command — you may tear down the Kōbō server itself or sibling dev servers.
- Do NOT start implementation even if a plan is ready — auto-loop will drive that afterwards, one task per iteration.
- If the user asks for changes, re-apply via MCP and re-check. Do NOT mark ready until they approve.`
