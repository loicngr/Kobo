import type { Router } from 'vue-router'
import {
  navigateToWorkspaceTarget,
  saveWorkspaceTargetForAuthentication,
  type WorkspaceTarget,
} from './sprint-navigation'

let router: Router | undefined
const received = new Set<string>()

export function validNotificationTarget(value: unknown): value is WorkspaceTarget {
  if (!value || typeof value !== 'object') return false
  const target = value as Record<string, unknown>
  return (
    Object.keys(target).every((key) => key === 'workspaceId' || key === 'sessionId') &&
    typeof target.workspaceId === 'string' &&
    target.workspaceId.length > 0 &&
    target.workspaceId.length <= 256 &&
    (target.sessionId === undefined ||
      (typeof target.sessionId === 'string' && target.sessionId.length > 0 && target.sessionId.length <= 256))
  )
}

export function workspaceTargetUrl(target: WorkspaceTarget): string {
  const query = target.sessionId ? `?session=${encodeURIComponent(target.sessionId)}` : ''
  return `${window.location.origin}${window.location.pathname}#/workspace/${encodeURIComponent(target.workspaceId)}${query}`
}

async function navigate(target: WorkspaceTarget): Promise<void> {
  if (!router || !validNotificationTarget(target)) return
  await navigateToWorkspaceTarget(router, target, {}, () => saveWorkspaceTargetForAuthentication(target))
}

export function openNotificationTarget(target: WorkspaceTarget): void {
  void navigate(target)
}

export function installNotificationNavigation(appRouter: Router): void {
  router = appRouter
  try {
    const saved = sessionStorage.getItem('kobo:notification-target')
    sessionStorage.removeItem('kobo:notification-target')
    if (saved) {
      const target: unknown = JSON.parse(saved)
      if (validNotificationTarget(target)) void appRouter.isReady().then(() => navigate(target))
    }
  } catch {
    /* storage unavailable or invalid */
  }
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.source !== navigator.serviceWorker.controller || !event.ports[0]) return
    const data = event.data as { type?: unknown; id?: unknown; target?: unknown } | null
    if (
      data?.type !== 'kobo-notification-click' ||
      typeof data.id !== 'string' ||
      data.id.length > 128 ||
      !validNotificationTarget(data.target)
    )
      return
    const port = event.ports[0]
    port.onmessage = (reply) => {
      if (
        reply.data?.type !== 'kobo-notification-deliver' ||
        reply.data.id !== data.id ||
        received.has(data.id as string)
      )
        return
      received.add(data.id as string)
      if (received.size > 256) received.delete(received.values().next().value as string)
      port.close()
      void appRouter.isReady().then(() => navigate(data.target as WorkspaceTarget))
    }
    port.postMessage({ type: 'kobo-notification-received', id: data.id })
  })
}
