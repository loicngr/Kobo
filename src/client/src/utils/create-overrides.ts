/** Keep reused-worktree setup safe without changing the selected permission mode. */

export type CreateOverrideId = 'setup-script-forced' | 'permission-mode-downgraded'

export type CreateAgentPermissionMode = 'plan' | 'bypass' | 'strict' | 'interactive'

export interface CreateFormInput {
  useExistingWorktree: boolean
  /** A resolved PR checkout may explicitly opt into running setup. */
  prCheckout?: boolean
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
  // ignores the flag outside PR imports, which allow an explicit setup choice.
  let skipSetupScript = input.skipSetupScript
  if (input.useExistingWorktree && !input.prCheckout && !skipSetupScript) {
    skipSetupScript = true
    applied.push('setup-script-forced')
  }

  const agentPermissionMode = input.agentPermissionMode

  return { skipSetupScript, agentPermissionMode, applied }
}
