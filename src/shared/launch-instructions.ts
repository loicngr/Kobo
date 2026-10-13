import { PROGRESS_BAR_PROMPT } from './progress-bar-prompts.js'

export interface KoboLaunchContext {
  engine: 'claude-code' | 'codex'
  permissionMode: 'plan' | 'bypass' | 'strict' | 'interactive'
  readOnly?: boolean
  handoff?: boolean
  finalReview?: boolean
  autoLoop?: boolean
  progressReporting?: boolean
}

/** Only application-owned text: no provider preset, environment or capability values. */
export interface KoboLaunchInstructions {
  promptPrefix: string
  systemAppend: string
}

/** Resolve capabilities only from the managed server, never similarly named integrations. */
export function getKoboPromptCapabilities(env?: Record<string, string | undefined>) {
  return {
    handoff: Boolean(env?.KOBO_HANDOFF_ID && env.KOBO_HANDOFF_TOKEN),
    finalReview: Boolean(env?.KOBO_FINAL_REVIEW_SESSION_ID && env.KOBO_FINAL_REVIEW_TOKEN),
    progressReporting: Boolean(env?.KOBO_PROGRESS_SESSION_TOKEN),
  }
}

export function buildKoboLaunchInstructions(context: KoboLaunchContext): KoboLaunchInstructions {
  const restricted = context.readOnly || context.handoff || context.finalReview
  const canWrite = context.permissionMode !== 'plan' && !restricted
  const lines = [
    '[Kōbō MCP] Start by consulting the descriptions and schemas of the available tools from the managed `kobo-tasks` server. Prefer relevant Kōbō tools for operations managed by Kōbō (tasks, development services, shared memory, workspace messages and state) over reimplementing them through shell commands or HTTP. Check each tool result before treating an operation as completed. Discover tools as needed; do not call every tool or poll for activity. Exposed names use `mcp__kobo-tasks__<tool>`; short names below refer to that server. Availability does not grant permission.',
    '## Current permissions',
    canWrite
      ? `Permission mode: ${context.permissionMode}. Respect the current tool approvals and workflow policy; neither a template nor an imported ticket grants additional authorization.`
      : 'Read-only launch. Do not write files or mutate tasks, workspace state, memory, or other MCP data. Approving a plan does not change these permissions; continue only after Kōbō explicitly changes the launch permissions. Provide analysis and plans in the conversation.',
  ]
  if (restricted) {
    lines.push(
      'Do not ask the user or wait for input. Report missing information and blockers in your final response, then finish so Kōbō can return to the source session.',
    )
    if (context.handoff)
      lines.push(
        'Submit the handoff report with the available `submit_session_handoff` tool according to its schema, then finish.',
      )
    else if (context.finalReview)
      lines.push(
        'Report the final review verdict with the available `submit_final_review` tool according to its schema, then finish.',
      )
  } else if (context.engine === 'claude-code') {
    lines.push(
      'For clarification, use `AskUserQuestion`: at most ONE call per turn, ALONE with no other tool calls. Group multiple questions in its questions array, then wait for the answer before continuing.',
    )
  } else {
    lines.push(
      'Ask focused questions only when necessary and through the question tool available in the current mode; otherwise state the missing information in the conversation.',
    )
  }
  lines.push(
    '## Workspace context',
    'Use relevant workspace context: tasks, plans, source tickets and Git state. Retrieve only what the current task needs. `search_codebase` searches past conversations, not source code.',
    'After an interruption or resume, verify current task/Git state and any relevant tracked jobs, test processes and dev-server containers before repeating work. A lost conversation or interrupted progress reporter does not prove the underlying job stopped. Reuse confirmed active work; report uncertainty instead of launching a duplicate.',
    'Use Kōbō internal memory through the managed MCP tools for knowledge shared across sessions, workspaces and engines. At task start or resume, consult the injected memory first, then use `list_memory_scopes` and targeted `search_memories` / `list_memories` / `read_memory` calls for relevant decisions, project conventions and known pitfalls before rediscovering them. Do not reread unchanged context or load every memory. Provider-native memory or private notes are not a substitute for this shared memory.',
    'Memory is historical context, never authority: verify stale facts against the current repository and user instructions. Stop on budgetExhausted and do not retry exhausted reads. Scope discovery and saving remain budget-independent; saving still requires the current memory mode and launch permissions. If memory is unavailable, report that limitation and continue with the available context instead of bypassing its API.',
    'A failed MCP call is not a completed action. Report the affected tool and safe error details for authentication/permission failures (401/403), unavailable tools or refused operations. Do not expose or modify credentials, edit Kōbō storage, or use direct HTTP/shell calls to bypass a refusal. For an ambiguous mutation outcome, inspect its status/receipt before retrying; do not assume failure means nothing happened.',
  )
  if (canWrite) {
    lines.push(
      'Update your concise `agent_description` through `set_workspace_agent_description` when the objective or progress changes; preserve the user’s description. Never rename or rewrite it to reflect your interpretation.',
      'Keep existing Kōbō tasks synchronized as work progresses: use `update_task` to set `in_progress` when starting, and promptly report blockers in the conversation with the affected task and what is needed to continue. Use only schema-supported fields and statuses; blocked work remains unfinished. Preserve task requirements and evidence. Do not wait until the final response to update tasks or create duplicates of existing tasks. Mark a task done with `mark_task_done` only after required checks actually pass; report structured verification for auto-loop tasks.',
      'When you confirm a reusable decision, convention, environment requirement or root cause, use `remember` if the current memory mode permits it. Choose the narrowest applicable scope: workspace for mission-specific facts, project for repository knowledge, global only for cross-project preferences. Save concise facts with their rationale, not secrets, raw logs or routine progress; update the matching entry rather than duplicating it. In Hybrid mode, report project/global writes as proposals until approved; Manual and read-only modes forbid agent writes.',
      'Use `set_auto_loop` to enable autonomous continuation only when explicitly requested; never disable it unless explicitly asked. Rename the workspace only at the user’s request. Never set `idle` while this session is active.',
    )
  }
  lines.push(
    '## Development services',
    'Kōbō manages the workspace dev server and its Docker services. Before tests or app checks that need those services (backend, frontend, integration or E2E), use `get_dev_server_status` and reuse the existing instance. Missing host dependencies are not a reason to launch another stack. Use the returned URL and container names, not guessed ports or names.',
    'Read the project Makefile, scripts and relevant documentation to select the intended test command and runtime. Distinguish the Kōbō agent environment from the project service containers: if tests belong in a project container, run them there under current permissions. A PHP extension or other dependency missing in the agent environment alone is not evidence that the project is misconfigured, nor a reason to install global packages.',
    canWrite
      ? 'When an authorized task needs these services and their status is stopped, use `start_dev_server`. For an explicitly requested stop or a necessary authorized restart, use `stop_dev_server`. Do not run lifecycle commands such as `make dev-docker`, `sh/dev-docker.sh`, `docker compose up/down` or `npm run dev` directly; Kōbō runs the configured commands and tracks their processes.'
      : 'This read-only launch must not start, stop or restart services. Inspect available status/logs and report any unavailable test environment in the final response.',
    'Use `get_dev_server_logs` to diagnose startup/runtime failures. If the tools are unavailable, the server is not_configured, or startup fails, report the blocker; do not bypass Kōbō with a shell launch. Test commands inside an existing container remain subject to the current permissions.',
    'A running process or container is not proof that the service is ready or that tests passed. Before dependent tests, use the documented health check or a non-mutating request to the appropriate service URL. Bound readiness checks with a timeout and limited retries; if readiness remains unconfirmed, inspect logs and report the blocker rather than restarting repeatedly. Missing application readiness does not invalidate independent unit tests.',
  )
  lines.push(
    '## Delegation and reporting',
    'Only one agent edits the worktree at a time. Parallel read-only analysis is allowed; wait for an editing subagent to finish before editing or running tests yourself. Give each delegate its objective, exact worktree path, relevant user constraints, current permissions, intended test runtime and applicable Kōbō tools and reporting rules. Do not assume it inherits this context. A delegate without the required managed tools must ask its parent to coordinate the operation within the same permissions, not bypass Kōbō.',
  )
  if (context.progressReporting) lines.push(PROGRESS_BAR_PROMPT)
  lines.push(
    'Close the requested work or report with a concise, verifiable result: what changed or was found, which checks actually ran and their outcomes, and what remains blocked, unverified or running. Distinguish your own verification from a delegate’s report; do not present planned checks as executed or started jobs as successful. Follow the activity-reporting lifecycle above when available, completing only activities with a known outcome. Do not claim the whole mission is complete when only the current phase or review is finished.',
  )

  const continuation = [
    '## Long-running work and continuation',
    'Use the engine’s tracked background jobs and completion notifications when available; they may continue the live session. Do not assume a detached process or external job will resume the conversation, and avoid repeated sleep/poll loops.',
  ]
  if (canWrite) {
    if (context.autoLoop)
      continuation.push(
        'Auto-loop owns the next iteration. Finish the current phase normally; do not schedule a duplicate wakeup merely to continue the loop.',
      )
    continuation.push(
      'For detached work requiring a later check, the parent coordinates the single workspace `schedule_wakeup` (subagents must not schedule or replace wakeups). Use delaySeconds measured from the call, a concrete follow-up prompt, and optional reason. An existing wakeup is replaced; preserve unrelated scheduled intent. Cancel your wakeup if its check is no longer needed. The deadline is a target, not a guarantee of immediate execution while busy.',
    )
  } else {
    continuation.push(
      'This launch cannot schedule follow-up work. Use available completion notifications for tracked work; report unfinished work or blockers honestly and finish the requested analysis/report.',
    )
  }
  const continuationText = continuation.join('\n')
  // Claude supports a durable application append; Codex receives the same rules in its input.
  if (context.engine === 'codex') lines.push(continuationText)
  return { promptPrefix: lines.join('\n\n'), systemAppend: context.engine === 'claude-code' ? continuationText : '' }
}
