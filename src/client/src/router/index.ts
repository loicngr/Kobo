import { Dialog, Notify } from 'quasar'
import i18n from 'src/i18n'
import { getWorkspaceQueueHost } from 'src/services/workspace-queue-bridge'
import { useSprintStore } from 'src/stores/sprints'
import { useWorkspaceStore } from 'src/stores/workspace'
import { getAuthenticationEpoch } from 'src/utils/auth-token'
import { isWorkspacePreviewNavigation } from 'src/utils/preview'
import {
  hasPanePendingWork,
  isPassiveSplitNavigation,
  isWorkspacePane,
  type WorkspacePaneWindow,
} from 'src/utils/split-workspace'
import {
  consumeInternalSprintTarget,
  consumeNotificationNavigation,
  invalidatePendingTargetNavigation,
  markInternalSprintTarget,
  resolveWorkspaceRoute,
  saveWorkspaceTargetForAuthentication,
  WorkspaceTargetAuthenticationError,
} from 'src/utils/sprint-navigation'
import { hasUnsavedWork, listDirtyScopes } from 'src/utils/unsaved-guard'
import { createRouter, createWebHashHistory } from 'vue-router'
import { defineRouter } from '#q-app'
import routes from './routes'

export default defineRouter(() => {
  const Router = createRouter({
    scrollBehavior: () => ({ left: 0, top: 0 }),
    routes,
    history: createWebHashHistory(),
  })

  let navigationVersion = 0
  let pendingWarning: { path: string; message: string; version: number } | null = null
  let acceptedRedirect: string | null = null
  let historyTarget: { path: string; internal: boolean } | null = null
  let internalForNavigation = false
  let notificationForNavigation: (() => void) | undefined
  let redirectedNotification: { path: string; version: number; callback: () => void } | null = null
  window.addEventListener('popstate', () => {
    historyTarget = { path: window.location.hash.slice(1), internal: window.history.state?.koboSprintContext === true }
  })

  Router.beforeEach((to, from) => {
    invalidatePendingTargetNavigation()
    navigationVersion++
    const id = typeof to.params.id === 'string' ? to.params.id : ''
    notificationForNavigation =
      consumeNotificationNavigation(id, to.query.session) ??
      (redirectedNotification?.path === to.fullPath && redirectedNotification.version === navigationVersion - 1
        ? redirectedNotification.callback
        : undefined)
    redirectedNotification = null
    const marked = consumeInternalSprintTarget(id, to.query.sprint)
    const historyInternal = historyTarget?.path === to.fullPath && historyTarget.internal
    historyTarget = null
    internalForNavigation =
      marked || !!historyInternal || (from.name == null && window.history.state?.koboSprintContext === true)
    if (pendingWarning?.path === to.fullPath) pendingWarning.version = navigationVersion
    else pendingWarning = null
    if (acceptedRedirect === to.fullPath) {
      acceptedRedirect = null
      return true
    }
    acceptedRedirect = null
    if (isPassiveSplitNavigation(to, from) || isWorkspacePreviewNavigation(to, from)) return true
    if (to.fullPath === from.fullPath || !listDirtyScopes().some((scope) => scope !== 'chat:message')) return true
    const t = i18n.global.t
    return new Promise<boolean>((resolve) => {
      Dialog.create({
        title: t('unsaved.title'),
        message: t('unsaved.message'),
        dark: true,
        cancel: { flat: true, label: t('unsaved.stay'), color: 'grey-5' },
        ok: { flat: true, label: t('unsaved.leave'), color: 'negative' },
      })
        .onOk(() => resolve(true))
        .onCancel(() => resolve(false))
    })
  })

  Router.beforeEach(async (to, from) => {
    const version = navigationVersion
    const notifyAuthentication = notificationForNavigation
    if (!isWorkspacePane && to.name === 'workspace' && !to.params.id && typeof to.query.sprint !== 'string') {
      const next = { name: 'workspace', query: { ...to.query, sprint: useSprintStore().active }, replace: true }
      acceptedRedirect = Router.resolve(next).fullPath
      return next
    }
    if (isWorkspacePane || to.name !== 'workspace' || typeof to.params.id !== 'string') return true
    const internal = internalForNavigation && typeof to.query.sprint === 'string'
    const sessionId = typeof to.query.session === 'string' ? to.query.session : undefined
    // Sidebar targets are already loaded; details can refresh after the route opens.
    if (internal && !sessionId) {
      const store = useWorkspaceStore()
      if ([...store.workspaces, ...store.archivedWorkspaces].some((workspace) => workspace.id === to.params.id))
        return true
    }
    try {
      const decision = await resolveWorkspaceRoute(
        { workspaceId: to.params.id, ...(sessionId ? { sessionId } : {}) },
        to.query,
        !internal,
      )
      if (version !== navigationVersion) return false
      if (decision.missing) {
        const next = { name: 'workspace', query: { sprint: useSprintStore().active }, replace: true }
        acceptedRedirect = Router.resolve(next).fullPath
        const message = i18n.global.t('sprints.workspaceMissing')
        if (acceptedRedirect === from.fullPath) {
          acceptedRedirect = null
          Notify.create({ type: 'warning', message, position: 'top' })
          return false
        }
        pendingWarning = { path: acceptedRedirect, message, version }
        return next
      }
      if (!decision.needsRedirect) return true
      const next = {
        name: 'workspace',
        state: { koboSprintContext: true },
        params: to.params,
        query: decision.query,
        replace: true,
      }
      acceptedRedirect = Router.resolve(next).fullPath
      if (decision.sessionMissing && acceptedRedirect === from.fullPath) {
        acceptedRedirect = null
        Notify.create({ type: 'warning', message: i18n.global.t('sprints.sessionMissing'), position: 'top' })
        return false
      }
      if (notifyAuthentication)
        redirectedNotification = { path: acceptedRedirect, version, callback: notifyAuthentication }
      if (typeof decision.query.sprint === 'string') markInternalSprintTarget(to.params.id, decision.query.sprint)
      if (decision.sessionMissing)
        pendingWarning = { path: acceptedRedirect, message: i18n.global.t('sprints.sessionMissing'), version }
      return next
    } catch (error) {
      if (version === navigationVersion && error instanceof WorkspaceTargetAuthenticationError) {
        if (error.epoch === getAuthenticationEpoch()) {
          if (notifyAuthentication) notifyAuthentication()
          else if (from.name == null)
            saveWorkspaceTargetForAuthentication({ workspaceId: to.params.id, ...(sessionId ? { sessionId } : {}) })
        }
        return false
      }
      if (version === navigationVersion)
        Notify.create({ type: 'negative', message: i18n.global.t('sprints.error'), position: 'top' })
      return false
    }
  })

  Router.afterEach((to, _from, failure) => {
    if (!failure && pendingWarning?.path === to.fullPath && pendingWarning.version === navigationVersion) {
      Notify.create({ type: 'warning', message: pendingWarning.message, position: 'top' })
      pendingWarning = null
    }
  })

  // Tab close / reload: modern browsers ignore any custom message here and
  // show their own generic prompt, so we only ever set returnValue to signal
  // "something to lose" — unsaved.title/message are never rendered by this path.
  const hasPendingPaneWork = () => {
    const store = useWorkspaceStore()
    // Mirrored queues outlive this pane; only their owner must guard their destruction.
    return hasPanePendingWork(
      hasUnsavedWork() ||
        Object.values(store.chatComposerDrafts).some((draft) => !!draft.text.trim() || draft.attachments.length > 0),
      getWorkspaceQueueHost(store) ? {} : store.queuedMessages,
    )
  }
  window.addEventListener('beforeunload', (event) => {
    if (!hasPendingPaneWork()) return
    event.preventDefault()
    event.returnValue = ''
  })

  if (isWorkspacePane) {
    ;(window as WorkspacePaneWindow).koboPane = {
      hasUnsavedWork: hasPendingPaneWork,
      ready: () => Router.currentRoute.value.name != null,
      navigate: (id) => Router.push({ name: 'workspace', params: { id } }),
      workspaceId: () =>
        typeof Router.currentRoute.value.params.id === 'string' ? Router.currentRoute.value.params.id : undefined,
    }
  }

  return Router
})
