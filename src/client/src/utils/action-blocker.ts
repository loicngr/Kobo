export type ActionBlocker = 'noWorkspace' | 'purged' | 'archived' | 'operation' | 'agentBusy' | 'configuration'

/** Shared source for both disabled state and explanation; first actionable cause wins. */
export function getActionBlocker(context: {
  missingWorkspace?: boolean
  purged?: boolean
  archived?: boolean
  operation?: boolean
  agentBusy?: boolean
  missingConfiguration?: boolean
}): ActionBlocker | null {
  if (context.missingWorkspace) return 'noWorkspace'
  if (context.purged) return 'purged'
  if (context.archived) return 'archived'
  if (context.operation) return 'operation'
  if (context.agentBusy) return 'agentBusy'
  if (context.missingConfiguration) return 'configuration'
  return null
}
