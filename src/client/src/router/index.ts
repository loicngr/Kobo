import { Dialog } from 'quasar'
import i18n from 'src/i18n'
import { getWorkspaceQueueHost } from 'src/services/workspace-queue-bridge'
import { useWorkspaceStore } from 'src/stores/workspace'
import {
  hasPanePendingWork,
  isPassiveSplitNavigation,
  isWorkspacePane,
  type WorkspacePaneWindow,
} from 'src/utils/split-workspace'
import { hasUnsavedWork } from 'src/utils/unsaved-guard'
import { createRouter, createWebHashHistory } from 'vue-router'
import { defineRouter } from '#q-app'
import routes from './routes'

export default defineRouter(() => {
  const Router = createRouter({
    scrollBehavior: () => ({ left: 0, top: 0 }),
    routes,
    history: createWebHashHistory(),
  })

  // No guard existed anywhere in the client: modified settings, a filled-in
  // creation form and a file edited in the diff viewer all vanished silently.
  //
  // Returns instead of the `next()` callback (deprecated in Vue Router 4.4+):
  // the dialog's onOk/onCancel are wrapped in a promise the guard awaits.
  Router.beforeEach((to, from) => {
    if (isPassiveSplitNavigation(to, from)) return true
    if (to.fullPath === from.fullPath || !hasUnsavedWork()) return true
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

  // Tab close / reload: modern browsers ignore any custom message here and
  // show their own generic prompt, so we only ever set returnValue to signal
  // "something to lose" — unsaved.title/message are never rendered by this path.
  const hasPendingPaneWork = () => {
    const store = useWorkspaceStore()
    // Mirrored queues outlive this pane; only their owner must guard their destruction.
    return hasPanePendingWork(hasUnsavedWork(), getWorkspaceQueueHost(store) ? {} : store.queuedMessages)
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
