// Historical shipped prompts used only for exact-match migrations. Do not edit.
export const LEGACY_CI_FIX_PROMPT_TEMPLATE = `The CI pipeline is failing on this branch. Investigate and fix every failing job.

Context:
- Workspace: {{workspace_name}}
- Project: {{project_name}}
- Branch: \`{{branch_name}}\` → \`{{source_branch}}\`
- PR: {{pr_url}} (#{{pr_number}})

Failing jobs:
{{failed_jobs}}

Steps:
1. For each failing job, fetch its logs from the forge and pinpoint the root cause.
2. Fix the underlying issue locally — never disable a check or skip a test to "fix" CI.
3. Run the relevant lint / type-check / test commands locally to verify the fix.
4. Commit with a clear, conventional message and push to the same branch.
5. Wait for CI to re-run and confirm every job now passes.
`

export const LEGACY_PR_PROMPT_TEMPLATE = `A pull request has been opened: {{pr_url}} (#{{pr_number}})

Context:
- Workspace: {{workspace_name}}
- Project: {{project_name}}
- Branch: \`{{branch_name}}\` → \`{{source_branch}}\`
- Notion: {{notion_url}}

Changes:
{{diff_stats}}

Commits:
{{commits}}

Tasks:
{{tasks}}

Acceptance criteria:
{{acceptance_criteria}}

Please:
1. Review the PR description on GitHub and improve it if needed (add a proper summary, screenshots if relevant, a test plan)
2. Verify that all acceptance criteria are checked
3. Post a comment on the PR summarizing what was done and any follow-up items
4. Do NOT add a "Generated with Claude Code" footer or any AI attribution to the PR description
`

export const LEGACY_FINALIZATION_PROMPT = `Run final quality checks before closing the workspace:

1. Verify all work tasks and acceptance criteria are marked \`done\`. If any remain pending/in_progress, keep finalization open and report them.
2. Run the project's linters, type-checkers, and tests (see CLAUDE.md or package.json scripts).
3. If any check fails or cannot be run, create a regular repair task with a title like \`Fix lint failure in X\` (role \`work\`, no \`[FINAL]\` prefix), record the failed/not_run checks and leave this finalization task pending. Kōbō will process the repairs first, then run final verification again against the repaired state.
4. Only after all required checks actually pass, mark this task as \`done\` with structured verification: method, summary, and the named checks with status \`passed\`.

HARD RULE: Do NOT open a pull request, do NOT run \`gh pr create\` or any equivalent command. The finalization step never opens a PR — that is a separate, explicit user action via the "Open PR" button.`

export const LEGACY_NOTION_INITIAL_PROMPT = `MANDATORY context-enrichment for Notion ticket {ticket_id}. Run this BEFORE any codebase exploration, sub-agent dispatch, brainstorming skill, or ExitPlanMode call.

1. Read {notion_file_path}.
2. Fetch every linked Notion resource via the Notion MCP tools: sub-tickets, references, linked blocks, linked databases. Recurse one level into anything that looks task-relevant.
3. Persist EVERYTHING you found to {notion_file_path}. Inline the sub-page content, extracted requirements, acceptance criteria, dependencies, key field values. The file becomes the single source of truth — anything not written there is invisible to the downstream agent.
   - If Edit/Write is available right now: use it immediately on {notion_file_path}, then move on.
   - If you are in plan mode and Edit/Write is blocked: the very FIRST line of your implementation plan MUST be a verbatim Edit/Write call on {notion_file_path} with the full enriched content. Not a paraphrase, not a TODO — the literal tool call with the file path and the new content. Place it BEFORE any code change in the plan.
4. After the file is written (or after ExitPlanMode if you were in plan mode), re-read {notion_file_path} to confirm.

HARD RULES:
- Do NOT call ExitPlanMode until step 2 has fetched the linked resources and you know what content step 3 will write.
- Do NOT skip step 3. "I have the context in mind" is NOT acceptable — write it to disk.
- Do NOT dispatch sub-agents to explore the codebase before {notion_file_path} is enriched (or planned to be enriched as line 1 of your plan).`

export const LEGACY_SENTRY_INITIAL_PROMPT = `MANDATORY context-enrichment for Sentry issue {issue_id}. Run this BEFORE locating the bug, writing tests, or implementing the fix.

1. Read {sentry_file_path}.
2. Use the Sentry MCP tools to fetch the latest events, breadcrumbs, tags, runtime/environment details, related issues and any reproduction hints.
3. Persist EVERYTHING you found to {sentry_file_path}. Inline stack frames, frequent breadcrumb sequences, environment matrix, related events, hypotheses. The file becomes the single source of truth — anything not written there is invisible to the downstream fix.
   - If Edit/Write is available right now: use it immediately on {sentry_file_path}.
   - If you are in plan mode and Edit/Write is blocked: the very FIRST line of your implementation plan MUST be a verbatim Edit/Write call on {sentry_file_path} with the full enriched content. Not a paraphrase, not a TODO — the literal tool call with the file path and the new content. Place it BEFORE any code change in the plan.
4. After the file is written, re-read {sentry_file_path} to confirm.

HARD RULES:
- Do NOT skip step 3. "I have the context in mind" is NOT acceptable — write it to disk.
- Do NOT explore the codebase or write a failing test before {sentry_file_path} is enriched (or planned to be enriched as line 1 of your plan).`

const LEGACY_REVIEW_HEADER = `You are reviewing code changes on workspace "{{workspace_name}}" in project {{project_name}}.

Branch: {{branch_name}}  (base: {{source_branch}})
Base commit: {{base_commit}}

`

const LEGACY_REVIEW_BODY = `## Scope

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

export const LEGACY_AGNOSTIC_REVIEW_TEMPLATE =
  LEGACY_REVIEW_HEADER +
  'If a code-review skill is available in this environment, invoke it to drive this audit. Otherwise follow the manual checklist below.\n\n' +
  LEGACY_REVIEW_BODY

export const LEGACY_AGNOSTIC_AUTO_LOOP_REVIEW_GATE =
  'Code review gate — BEFORE marking the task done, run whichever code-review skill is configured in this environment. Brief it with: what you just implemented, the task title, and the commit SHA (via `git rev-parse HEAD`). Ask specifically whether the change matches the task scope, whether edge cases are handled, and whether the commit is clean. If no review skill is available, do a manual self-review against the same criteria.'
