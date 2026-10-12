export const PROGRESS_BAR_PLAN_EXCEPTION =
  'Operational exception in Plan/read-only/review: the launch-scoped create_progress_bar, update_progress_bar, finish_progress_bar and list_progress_bars tools only report activity metadata and are allowed when provided by the managed kobo-tasks server. This does not authorize file, task, workspace, memory, or other MCP mutations.'

/** Shared across engines, fresh/resumed launches and delegated agents. */
export const PROGRESS_BAR_PROMPT = `<kobo-progress-reporting>
${PROGRESS_BAR_PLAN_EXCEPTION}
Use Kōbō's create_progress_bar, update_progress_bar and finish_progress_bar for long-running tasks, including tests and delegated work. Give each activity a clear label and stable activity_key; follow tool schemas for ordered updates and retries. Report meaningful steps and measured current/total only when known; otherwise keep progress indeterminate. Never invent percentages or poll these tools. Finish with succeeded or failed only when known. A dismissed bar stays hidden: continue without recreating it; dismissal is not cancellation. Reporting never substitutes for verification, and an interrupted reporter does not prove background work stopped.
Pass this requirement to all subagents when delegating. Subagents must not schedule or replace workspace wakeups; the parent coordinates follow-up. Each subagent reports its own long task through the inherited Kōbō MCP tools; the parent must not duplicate that activity. If a custom subagent lacks these tools, the parent reports its observed progress accurately instead. After resume, start new activity keys for new work; do not reopen a finished activity.
</kobo-progress-reporting>`
