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

export interface E2eSettings {
  framework: 'cypress' | 'playwright' | 'jest' | 'vitest' | 'other' | ''
  skill: string
  prompt: string
}

export const PREP_AUTOLOOP_INTRO = `You are preparing this workspace for Kōbō auto-loop mode. This is a GROOMING session only — DO NOT implement anything, DO NOT write or edit code, DO NOT run tests or builds, DO NOT invoke \`superpowers:executing-plans\` or any implementation skill. Your ONLY job is to curate the Kōbō task list via MCP tools.`

export function buildAutoLoopGroomingSteps(e2e: E2eSettings): string {
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

  if (e2e.framework) {
    const skillHint = e2e.skill ? `Use the \`${e2e.skill}\` skill for this task. ` : ''
    const promptHint = e2e.prompt ? `Additional guidance: ${e2e.prompt}` : ''
    steps.push(
      `4. **E2E review**: walk the task list and identify which tasks produce user-visible behavior (UI flows, form submissions, page renders, etc.). For each one that warrants regression coverage, INSERT a follow-up sub-task with title prefixed \`[E2E] \` describing the test to write. Place it in \`sort_order\` directly after the parent task. Skip tasks that don't produce user-visible behavior (refactors, infra, internal services) and briefly justify your choices in chat. The project uses \`${e2e.framework}\`. ${skillHint}${promptHint}`.trim(),
    )
    steps.push(
      `5. Call \`kobo__mark_auto_loop_ready\`. This will automatically start the auto-loop, which will pick up the tasks one by one in fresh sessions.`,
    )
  } else {
    steps.push(
      `4. Call \`kobo__mark_auto_loop_ready\`. This will automatically start the auto-loop, which will pick up the tasks one by one in fresh sessions.`,
    )
  }

  return steps.join('\n')
}

/** @deprecated Use buildAutoLoopGroomingSteps({ framework: '', skill: '', prompt: '' }) instead. */
export const AUTO_LOOP_GROOMING_STEPS = buildAutoLoopGroomingSteps({ framework: '', skill: '', prompt: '' })

export function buildE2eIterationBlock(e2e: E2eSettings): string {
  if (!e2e.framework) return ''
  const skillLine = e2e.skill ? `Use the \`${e2e.skill}\` skill for this task.\n` : ''
  const promptLine = e2e.prompt ? `Additional guidance: ${e2e.prompt}\n` : ''
  return `
This is an **E2E regression test** task.

Project E2E framework: ${e2e.framework}
${skillLine}${promptLine}
Hard rules specific to E2E tasks (these **override** the corresponding rules in the standard 8 steps below — read them before steps 3-4):
1. Write the test source file in the project's existing E2E directory (look at \`cypress/\`, \`e2e/\`, \`tests/e2e/\`, or follow the skill / guidance above). Reuse existing fixtures and patterns.
2. Try to run the tests locally. If they pass, great.
3. **If the environment is broken** (Docker down, browser missing, port busy, dependencies not installed, etc.) — do NOT spend iterations debugging infra. **Override of step 4 of the standard prompt below**: you do NOT need to fix failing tests in this case. Commit the test source file with a message like \`test(e2e): add regression for <feature>\`, then call \`kobo__mark_task_done\` with a note in the chat: \`E2E test written but not executed locally — <reason>. Replay once env is restored.\`
4. The code-review gate (step 6 of the standard prompt) still applies — the reviewer checks that the test is meaningful, not that it ran.
`
}

export const AUTO_LOOP_HARD_RULES = `Hard rules:
- Do NOT touch any source file. No Edit, no Write, no Bash that changes the repo.
- Do NOT run \`kill\`, \`pkill\`, \`killall\`, \`pgrep -k\`, or any process-killing command — you may tear down the Kōbō server itself or sibling dev servers.
- Do NOT start implementation even if a plan is ready — auto-loop will drive that afterwards, one task per iteration.
- If the user asks for changes, re-apply via MCP and re-check. Do NOT mark ready until they approve.`
