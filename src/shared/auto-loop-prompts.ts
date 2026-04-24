/**
 * Single source of truth for the auto-loop grooming instructions.
 *
 * Imported BOTH by the client (PREP_AUTOLOOP_PROMPT sent by the "Prepare
 * for auto-loop" button) and by the server (extended brainstorm prompt
 * injected at workspace creation when autoLoop=true). Keeping these two
 * paths aligned was a copy-paste hazard — this file eliminates that.
 *
 * `AUTO_LOOP_GROOMING_STEPS` is the numbered workflow, ready to be spliced
 * into a larger prompt with a one-line intro.
 *
 * `AUTO_LOOP_HARD_RULES` is the trailing hard-rules block, same for both.
 */

export const AUTO_LOOP_GROOMING_STEPS = `1. Call \`kobo__list_tasks\` FIRST to inspect any pre-existing tasks (they may have been seeded from Notion, a template, or the CreatePage form).
2. If tasks already exist: DO NOT delete or recreate them from scratch. Read each one, judge whether it is atomic and implementable in one session with clear completion criteria. Improve them in place:
   - Use \`kobo__update_task\` to rename unclear titles, add completion criteria, or flip \`is_acceptance_criterion\` when needed.
   - Use \`kobo__create_task\` to SPLIT a task that is too large into smaller atomic pieces (keep the original only if it still makes sense, otherwise update it to one of the split pieces and create the rest).
   - Use \`kobo__create_task\` to ADD missing acceptance criteria or missing implementation steps the plan requires.
3. If no tasks exist:
   - If a plan file exists in \`docs/superpowers/plans/\` or similar, read it and derive the task list from it.
   - If no plan exists, ask the user what the workspace goal is and propose tasks accordingly.
   - Create the tasks via \`kobo__create_task\`. For each task, decide \`is_acceptance_criterion\` appropriately.
4. Call \`kobo__mark_auto_loop_ready\`. This will automatically start the auto-loop, which will pick up the tasks one by one in fresh sessions.`

export const AUTO_LOOP_HARD_RULES = `Hard rules:
- Do NOT touch any source file. No Edit, no Write, no Bash that changes the repo.
- Do NOT run \`kill\`, \`pkill\`, \`killall\`, \`pgrep -k\`, or any process-killing command — you may tear down the Kōbō server itself or sibling dev servers.
- Do NOT start implementation even if a plan is ready — auto-loop will drive that afterwards, one task per iteration.
- If the user asks for changes, re-apply via MCP and re-check. Do NOT mark ready until they approve.`
