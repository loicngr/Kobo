/** Agent workflow preferences, independent of the engine sandbox and approval mode. */
export type WorkflowAction = 'commit' | 'push' | 'publish'
export type WorkflowMode = 'manual' | 'automatic'
export type WorkflowPolicy = Record<WorkflowAction, WorkflowMode>
export const WORKFLOW_ACTIONS: readonly WorkflowAction[] = ['commit', 'push', 'publish']
export const MANUAL_WORKFLOW_POLICY: Readonly<WorkflowPolicy> = { commit: 'manual', push: 'manual', publish: 'manual' }
/** Existing installations keep their previous autonomous workflow; explicit user constraints still win. */
export const LEGACY_WORKFLOW_POLICY: Readonly<WorkflowPolicy> = {
  commit: 'automatic',
  push: 'automatic',
  publish: 'automatic',
}
export function isWorkflowPolicy(value: unknown): value is Partial<WorkflowPolicy> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([key, mode]) => WORKFLOW_ACTIONS.includes(key as WorkflowAction) && (mode === 'manual' || mode === 'automatic'),
    )
  )
}
export function resolveWorkflowPolicy(...layers: Array<Partial<WorkflowPolicy> | undefined | null>): WorkflowPolicy {
  const result = { ...MANUAL_WORKFLOW_POLICY }
  for (const layer of layers) {
    if (isWorkflowPolicy(layer)) Object.assign(result, layer)
  }
  return result
}
export function renderWorkflowPolicy(policy: WorkflowPolicy = MANUAL_WORKFLOW_POLICY): string {
  return `[Kōbō workflow preferences]\n${WORKFLOW_ACTIONS.map((action) => `- ${action}: ${policy[action]}`).join('\n')}\nManual means require explicit user authorization for that action; an explicit request authorizes that operation only, not future operations. Automatic means the configured preference supplies the authorization requested by built-in workflow prompts for that action when necessary for this mission. Always follow more restrictive user instructions (including no commits, no push or no publication), repository constraints and actual tool permissions. Publish covers creating or updating PR/MR descriptions and comments. Never merge a PR/MR based on these preferences; merging needs separate explicit authorization. These preferences are instructions, not an OS sandbox or a guarantee against arbitrary commands. Do not change sandbox or approval settings to satisfy a preference.\n`
}
