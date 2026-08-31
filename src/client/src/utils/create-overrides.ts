/**
 * Two settings on the create page are silently overridden by the form itself.
 * Both used to live as inline ternaries inside the request payload, so nothing
 * guaranteed the UI showed what the network actually sent — and the user could
 * flip a toggle that had no effect, with no explanation.
 *
 * This resolves both in one place and, crucially, REPORTS which overrides
 * applied so the page can say so out loud.
 */

export type CreateOverrideId = 'setup-script-forced' | 'permission-mode-downgraded'

export type CreateAgentPermissionMode = 'plan' | 'bypass' | 'strict' | 'interactive'

export interface CreateFormInput {
  useExistingWorktree: boolean
  skipSetupScript: boolean
  autoLoop: boolean
  agentPermissionMode: CreateAgentPermissionMode
}

export interface CreateResolvedOverrides {
  skipSetupScript: boolean
  agentPermissionMode: CreateAgentPermissionMode
  applied: CreateOverrideId[]
}

export function resolveCreateOverrides(input: CreateFormInput): CreateResolvedOverrides {
  const applied: CreateOverrideId[] = []

  // Reusing a worktree the user curated: re-running the setup script could be
  // destructive (dropping a warmed node_modules / vendor tree), so the server
  // ignores the flag. Report it rather than leaving a live toggle that lies.
  let skipSetupScript = input.skipSetupScript
  if (input.useExistingWorktree && !skipSetupScript) {
    skipSetupScript = true
    applied.push('setup-script-forced')
  }

  // Plan mode blocks MCP calls and edits, which an auto-loop needs. The
  // downgrade is a real change of security posture, not a UI detail.
  let agentPermissionMode = input.agentPermissionMode
  if (input.autoLoop && agentPermissionMode === 'plan') {
    agentPermissionMode = 'bypass'
    applied.push('permission-mode-downgraded')
  }

  return { skipSetupScript, agentPermissionMode, applied }
}
