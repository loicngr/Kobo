import { useLayoutStore } from 'src/stores/layout'
import { useSettingsStore } from 'src/stores/settings'
import type { TourDefinition, TourStep } from './types'

/** Every home step lives in the left drawer: open it first (it may be closed on small screens). */
function drawerStep(id: string, anchor: string, i18nKey: string): TourStep {
  return {
    id,
    anchor,
    i18nKey,
    beforeShow: async () => useLayoutStore().setLeft(true),
  }
}

export const homeTour: TourDefinition = {
  id: 'home',
  route: 'workspace',
  i18nKey: 'tours.home',
  // Spec: the first tour hands over to the next thing to do. A workspace already
  // open is left alone; without any project the create form would be empty, so
  // the settings come first.
  onDone: (router) => {
    if (router.currentRoute.value.params.id) return
    const hasProject = useSettingsStore().projectPaths.length > 0
    void router.push({ name: hasProject ? 'create' : 'settings' })
  },
  steps: [
    drawerStep('home-list', 'workspace-list', 'tours.home.list'),
    drawerStep('home-create', 'create-workspace', 'tours.home.create'),
    drawerStep('home-search', 'search', 'tours.home.search'),
    drawerStep('home-dashboard', 'dashboard', 'tours.home.dashboard'),
    drawerStep('home-health', 'health', 'tours.home.health'),
    drawerStep('home-settings', 'settings', 'tours.home.settings'),
  ],
}
