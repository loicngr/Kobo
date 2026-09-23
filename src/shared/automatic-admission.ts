/** Read-only admission status for a new unattended session, not delivery into an existing conversation. */
export type AutomaticAdmissionReason =
  | 'not-found'
  | 'archived'
  | 'purged'
  | 'shutdown'
  | 'lifecycle'
  | 'active-session'
  | 'awaiting-user'
  | 'compacting'
  | 'quota'
  | 'blocked'
  | 'capacity'
export interface AutomaticAdmissionStatus {
  allowed: boolean
  reason: AutomaticAdmissionReason | null
  running: number
  limit: number
}
