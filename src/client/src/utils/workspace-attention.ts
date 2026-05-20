import type { PrSnapshot, Workspace } from 'src/stores/workspace'
import { isChangesRequestedBlocking, isCiFailed } from './pr-status'

export type AttentionKind = 'awaiting-user' | 'error' | 'quota' | 'ci-failed' | 'changes-requested'

/** A single reason a workspace card surfaces in the "Needs Attention" group. */
export interface AttentionReason {
  kind: AttentionKind
  icon: string
  color: string
}

const STATUS_REASONS: Record<string, AttentionReason> = {
  'awaiting-user': { kind: 'awaiting-user', icon: 'help', color: 'amber-5' },
  error: { kind: 'error', icon: 'warning', color: 'red-5' },
  quota: { kind: 'quota', icon: 'warning', color: 'red-5' },
}

/**
 * Ordered list of attention reasons for a workspace card: the status-derived
 * reason first (agent question / error / quota), then PR-derived reasons
 * (failing CI, then blocking changes-requested). Empty when nothing needs
 * attention.
 */
export function getAttentionReasons(workspace: Workspace, snapshot: PrSnapshot | undefined): AttentionReason[] {
  const reasons: AttentionReason[] = []
  const statusReason = STATUS_REASONS[workspace.status]
  if (statusReason) reasons.push(statusReason)
  if (snapshot && isCiFailed(snapshot)) {
    reasons.push({ kind: 'ci-failed', icon: 'cancel', color: 'red-5' })
  }
  if (snapshot && isChangesRequestedBlocking(snapshot)) {
    reasons.push({ kind: 'changes-requested', icon: 'rate_review', color: 'red-5' })
  }
  return reasons
}
