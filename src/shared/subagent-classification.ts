/** SDK task lifecycle also covers shell commands, workflows and background MCP calls. */
export function isSubagentTask(task: { taskType?: string }): boolean {
  // Missing/custom classifications are retained for legacy history and Codex.
  return !['local_bash', 'local_workflow', 'mcp_task'].includes(task.taskType ?? '')
}
