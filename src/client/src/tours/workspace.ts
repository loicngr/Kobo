import { useLayoutStore } from 'src/stores/layout'
import { anchorPresent, clickAnchor } from './dom'
import type { TourDefinition, TourStep } from './types'

/**
 * Open the right drawer (closed on small screens, or by the user) then select a tab by
 * clicking its nav anchor: the tab model lives in `MainLayout.vue`, not in the store.
 */
async function openRightTab(navAnchor: string, panelAnchor: string): Promise<boolean> {
  useLayoutStore().setRight(true)
  return clickAnchor(navAnchor, panelAnchor)
}

function tabStep(name: string, i18nKey: string): TourStep {
  return {
    id: `ws-tab-${name}`,
    anchor: `ws-tab-${name}`,
    i18nKey,
    clickTarget: `ws-tabnav-${name}`,
    beforeShow: () => openRightTab(`ws-tabnav-${name}`, `ws-tab-${name}`),
  }
}

export const workspaceTour: TourDefinition = {
  id: 'workspace',
  route: 'workspace',
  i18nKey: 'tours.workspace',
  steps: [
    { id: 'ws-chat', anchor: 'ws-chat', i18nKey: 'tours.workspace.chat' },
    { id: 'ws-input', anchor: 'ws-input', i18nKey: 'tours.workspace.input' },
    {
      id: 'ws-selectors',
      anchor: 'ws-selectors',
      i18nKey: 'tours.workspace.selectors',
      // The toolbar selectors are hidden on mobile.
      when: () => anchorPresent('ws-selectors'),
      gate: 'dom',
    },
    { id: 'ws-status', anchor: 'ws-status', i18nKey: 'tours.workspace.status' },
    tabStep('git', 'tours.workspace.git'),
    tabStep('tasks', 'tours.workspace.tasks'),
    tabStep('timeline', 'tours.workspace.timeline'),
    {
      ...tabStep('subagents', 'tours.workspace.subagents'),
      // The sub-agents tab sits under a `v-if` and only exists once a session
      // spawned one; the step is skipped until then and shows up on a later run.
      when: () => anchorPresent('ws-tabnav-subagents'),
      gate: 'dom',
    },
    tabStep('documents', 'tours.workspace.documents'),
    tabStep('schedule', 'tours.workspace.schedule'),
    {
      id: 'ws-terminal',
      anchor: 'ws-terminal',
      i18nKey: 'tours.workspace.terminal',
      clickTarget: 'ws-tabnav-terminal',
      beforeShow: () => openRightTab('ws-tabnav-terminal', 'ws-terminal'),
    },
  ],
}
