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

/**
 * True when the `status` column claims the agent is busy but the server's
 * live controller registry has *positively confirmed* there is none — the
 * exact "status lies" shape this whole liveness effort exists to surface.
 *
 * `hasController` must reflect a controller-registry read that has actually
 * completed for this workspace (e.g. an entry present/absent in a liveness
 * map already populated by a server response). Never derive it from "we
 * haven't fetched liveness yet" — absence of data is not confirmation of
 * absence of an agent, and passing `false` for that unknown state would
 * wrongly mark a genuinely busy workspace as stale.
 */
export function isAgentStatusStale(status: string | null | undefined, hasController: boolean): boolean {
  return isBusyStatus(status) && !hasController
}

/**
 * True when the UI should surface the "agent not running" warning for
 * `status`. This is the piece `AgentLivenessChip.vue` and `AgentBusyBanner.vue`
 * were each computing inline before this fix: `hasController` alone cannot
 * tell "confirmed no controller" apart from "no liveness read has completed
 * yet for this workspace's current status" — both look like a missing entry
 * in the liveness map. Sending a message flips `status` to busy instantly
 * over WebSocket while the liveness confirmation is still an HTTP round trip
 * away; without `hasLoadedLiveness` that in-flight window was misread as a
 * confirmed absence and the warning fired on every message.
 *
 * `hasLoadedLiveness` must reflect a liveness read that completed *after*
 * the workspace's current status took effect (see `agentLivenessLoaded` in
 * the workspace store, invalidated on every status change and re-set once a
 * fresh read — targeted `GET /:id` or the bulk `/info` poll — resolves).
 * When it's false we don't know either way, so we pass `isAgentStatusStale`
 * a `hasController` of `true` to keep it silent — absence of data must never
 * be treated as confirmation of absence.
 */
export function shouldWarnAgentNotRunning(
  status: string | null | undefined,
  hasLoadedLiveness: boolean,
  hasController: boolean,
): boolean {
  return isAgentStatusStale(status, !hasLoadedLiveness || hasController)
}
