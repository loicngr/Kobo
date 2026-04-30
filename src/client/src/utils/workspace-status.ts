/**
 * Workspace status helpers shared across the UI.
 *
 * A workspace's `status` is a free-form string on the wire, but the subset
 * listed in `BUSY_STATUSES` carries the specific meaning "the agent is
 * currently running". Several components need to gate UI (disable inputs,
 * show the busy banner, block setup-script reruns, etc.) on this concept —
 * keep them in sync through this single source of truth.
 */

export const BUSY_STATUSES = ['executing', 'extracting', 'brainstorming'] as const

export type BusyStatus = (typeof BUSY_STATUSES)[number]

/** True when the workspace's status means the agent is actively running. */
export function isBusyStatus(status: string | null | undefined): boolean {
  return !!status && (BUSY_STATUSES as readonly string[]).includes(status)
}
