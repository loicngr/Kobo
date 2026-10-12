export const PROGRESS_BAR_PLAN_EXCEPTION =
  'Operational exception in Plan/read-only/review: the launch-scoped create_progress_bar, update_progress_bar, finish_progress_bar and list_progress_bars tools only report activity metadata and are allowed when provided by the managed kobo-tasks server. This does not authorize file, task, workspace, memory, or other MCP mutations.'

/** Shared across engines, fresh/resumed launches and delegated agents. */
export const PROGRESS_BAR_PROMPT = `<kobo-progress-reporting>
${PROGRESS_BAR_PLAN_EXCEPTION}
For each long-running activity (tests, audits, builds or delegated work), follow this reporting lifecycle:
1. Call create_progress_bar with a clear label, current step and stable activity_key. Save its returned id and sequence; creating a bar is only the start of reporting.
2. Call update_progress_bar with that id and an increasing sequence: update the same bar at each actual phase change or meaningful completed milestone, including during a long phase. Even without a measured percentage, report the current step; omit both current and total for step-only updates. Use measured numbers only when known. Never invent percentages, poll, send unchanged updates or start timer-driven reporting loops; follow tool retry guidance.
3. Call finish_progress_bar on that id before your final report (or return to the parent) when the activity's succeeded/failed outcome is known. Do not declare ongoing background work finished merely because you are yielding control.
Pass this requirement to all subagents when delegating: each reports and finishes its own long activity through inherited Kōbō MCP tools; the parent must not duplicate it. If a custom subagent lacks these tools, the parent reports its observed milestones and outcome instead. Subagents must not schedule or replace workspace wakeups; the parent coordinates follow-up.
A dismissed bar stays hidden: continue without recreating it; dismissal is not cancellation. Reporting never substitutes for verification, and an interrupted reporter does not prove background work stopped. After resume, use new activity keys for new work; do not reopen finished activities.
</kobo-progress-reporting>`
