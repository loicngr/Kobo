import { Notify } from 'quasar'
import i18n from 'src/i18n'
import { NO_SPRINT } from 'src/stores/sprints'
import type { AgentSession, Workspace } from 'src/stores/workspace'
import { apiFetchResponse } from 'src/utils/api'
import { getAuthenticationEpoch } from 'src/utils/auth-token'
import type { LocationQueryRaw, Router } from 'vue-router'

let navigationVersion = 0

export function invalidatePendingTargetNavigation() {
  navigationVersion++
}

let internalTarget: { id: string; sprint: string } | null = null
export function markInternalSprintTarget(id: string, sprint: string) {
  const marker = { id, sprint }
  internalTarget = marker
  return () => {
    if (internalTarget === marker) internalTarget = null
  }
}
export function consumeInternalSprintTarget(id: string, sprint: unknown) {
  const matches = internalTarget?.id === id && internalTarget.sprint === sprint
  internalTarget = null
  return matches
}

export type WorkspaceTarget = { workspaceId: string; sessionId?: string }

let notificationNavigation: { target: WorkspaceTarget; onAuthenticationRequired: () => void } | null = null
function markNotificationNavigation(target: WorkspaceTarget, onAuthenticationRequired: () => void) {
  const marker = { target, onAuthenticationRequired }
  notificationNavigation = marker
  return () => {
    if (notificationNavigation === marker) notificationNavigation = null
  }
}
export function consumeNotificationNavigation(workspaceId: unknown, sessionId: unknown) {
  const marker = notificationNavigation
  notificationNavigation = null
  return marker && marker.target.workspaceId === workspaceId && marker.target.sessionId === sessionId
    ? marker.onAuthenticationRequired
    : undefined
}

export class WorkspaceTargetAuthenticationError extends Error {
  constructor(readonly epoch: number) {
    super()
  }
}

export function saveWorkspaceTargetForAuthentication(target: WorkspaceTarget) {
  try {
    sessionStorage.setItem('kobo:notification-target', JSON.stringify(target))
  } catch {
    /* storage unavailable */
  }
}

function requireWorkspaceResponse(response: Response, epoch: number) {
  if (response.status === 401) throw new WorkspaceTargetAuthenticationError(epoch)
  if (!response.ok) throw new Error(i18n.global.t('sprints.error'))
}

/** Read membership after session validation so reassignment during that read is observed. */
export async function resolveWorkspaceTarget(target: WorkspaceTarget) {
  const epoch = getAuthenticationEpoch()
  const path = `/api/workspaces/${encodeURIComponent(target.workspaceId)}`
  let response = await apiFetchResponse(path)
  if (response.status === 404) return null
  requireWorkspaceResponse(response, epoch)
  let workspace = (await response.json()) as Workspace
  let sessionId = target.sessionId
  let sessionMissing = false
  if (sessionId) {
    const sessionsResponse = await apiFetchResponse(`${path}/sessions`)
    if (sessionsResponse.status === 404) {
      const current = await apiFetchResponse(path)
      if (current.status === 404) return null
      requireWorkspaceResponse(current, epoch)
      throw new Error(i18n.global.t('sprints.error'))
    }
    requireWorkspaceResponse(sessionsResponse, epoch)
    const sessions = (await sessionsResponse.json()) as AgentSession[]
    sessionMissing = !sessions.some((session) => session.id === sessionId && session.workspaceId === target.workspaceId)
    if (sessionMissing) sessionId = undefined
    response = await apiFetchResponse(path)
    if (response.status === 404) return null
    requireWorkspaceResponse(response, epoch)
    workspace = (await response.json()) as Workspace
  }
  return { sprintId: workspace.sprintId ?? NO_SPRINT, sessionId, sessionMissing }
}

/** Build the route guard decision using the same target validation as explicit links. */
export async function resolveWorkspaceRoute(target: WorkspaceTarget, query: LocationQueryRaw, resolveSprint: boolean) {
  const resolved = await resolveWorkspaceTarget(target)
  if (!resolved) return { missing: true as const }
  const sprint = resolveSprint ? resolved.sprintId : query.sprint
  const needsRedirect = sprint !== query.sprint || resolved.sessionMissing
  const nextQuery: LocationQueryRaw = { ...query, sprint }
  if (resolved.sessionMissing) delete nextQuery.session
  return { missing: false as const, query: nextQuery, needsRedirect, sessionMissing: resolved.sessionMissing }
}

/** Resolve membership at navigation time; caller-supplied sprint data is never used. */
export async function navigateToWorkspaceTarget(
  router: Router,
  target: WorkspaceTarget,
  query: LocationQueryRaw = {},
  onAuthenticationRequired?: () => void,
) {
  const version = ++navigationVersion
  try {
    const resolved = await resolveWorkspaceTarget(target)
    if (version !== navigationVersion) return false
    if (!resolved) {
      const failure = await router.push({ name: 'workspace' })
      if (!failure)
        Notify.create({ type: 'warning', message: i18n.global.t('sprints.workspaceMissing'), position: 'top' })
      return false
    }
    const resolvedTarget = {
      workspaceId: target.workspaceId,
      ...(resolved.sessionId ? { sessionId: resolved.sessionId } : {}),
    }
    const clearMarker = onAuthenticationRequired
      ? markNotificationNavigation(resolvedTarget, onAuthenticationRequired)
      : undefined
    let failure: Awaited<ReturnType<Router['push']>>
    try {
      failure = await router.push({
        name: 'workspace',
        state: { koboSprintContext: true },
        params: { id: target.workspaceId },
        query: { ...query, sprint: resolved.sprintId, ...(resolved.sessionId ? { session: resolved.sessionId } : {}) },
      })
    } finally {
      clearMarker?.()
    }
    if (!failure && resolved.sessionMissing)
      Notify.create({ type: 'warning', message: i18n.global.t('sprints.sessionMissing'), position: 'top' })
    return !failure
  } catch (error) {
    if (version === navigationVersion && error instanceof WorkspaceTargetAuthenticationError) {
      if (error.epoch === getAuthenticationEpoch()) onAuthenticationRequired?.()
      return false
    }
    if (version === navigationVersion)
      Notify.create({
        type: 'negative',
        message: error instanceof Error ? error.message : i18n.global.t('sprints.error'),
        position: 'top',
      })
    return false
  }
}
