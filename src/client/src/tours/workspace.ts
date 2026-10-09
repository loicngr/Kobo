import { useLayoutStore } from 'src/stores/layout'
import { useWorkspaceStore } from 'src/stores/workspace'
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
      // The configuration button is present whenever a workspace is selected.
      when: () => anchorPresent('ws-selectors'),
      gate: 'dom',
    },
    {
      id: 'ws-sessions',
      anchor: 'ws-sessions',
      i18nKey: 'tours.workspace.sessions',
      when: () => anchorPresent('ws-sessions'),
      gate: 'dom',
    },
    {
      id: 'ws-actions',
      anchor: 'ws-actions',
      i18nKey: 'tours.workspace.actions',
      when: () => anchorPresent('ws-actions'),
      gate: 'dom',
    },
    {
      id: 'ws-review-return',
      anchor: 'ws-review-return',
      i18nKey: 'tours.workspace.reviewReturn',
      when: () => anchorPresent('ws-review-return'),
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
    tabStep('memory', 'tours.workspace.memory'),
    {
      id: 'ws-memory-settings',
      anchor: 'ws-memory-settings',
      i18nKey: 'tours.workspace.memorySettings',
      clickTarget: 'ws-tabnav-memory',
      beforeShow: async () => {
        if (!(await openRightTab('ws-tabnav-memory', 'ws-tab-memory'))) return
        // The panel shell can precede its lazy-loaded component. Scroll only
        // once the link exists, including when replaying this step on its own.
        for (let attempt = 0; attempt < 40; attempt++) {
          const link = document.querySelector<HTMLElement>('[data-tour="ws-memory-settings"]')
          if (link) {
            link.scrollIntoView({ block: 'center' })
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      },
    },
    {
      id: 'ws-final-review',
      anchor: 'ws-final-review',
      i18nKey: 'tours.workspace.finalReview',
      when: () => !!useWorkspaceStore().selectedWorkspaceId,
      clickTarget: 'ws-tabnav-tools',
      beforeShow: async () => {
        if (!(await openRightTab('ws-tabnav-tools', 'ws-tab-tools'))) return
        for (let attempt = 0; attempt < 40; attempt++) {
          const settings = document.querySelector<HTMLElement>('[data-tour="ws-final-review"]')
          if (settings) {
            settings.scrollIntoView({ block: 'center' })
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      },
    },
    {
      id: 'ws-session-handoff',
      anchor: 'ws-session-handoff',
      i18nKey: 'tours.workspace.handoff',
      when: () => !!useWorkspaceStore().selectedWorkspaceId,
      clickTarget: 'ws-tabnav-tools',
      beforeShow: async () => {
        if (!(await openRightTab('ws-tabnav-tools', 'ws-tab-tools'))) return
        const panel = document.querySelector<HTMLElement>('[data-tour="ws-tab-tools"]')
        if (panel) panel.scrollTop = panel.scrollHeight
      },
    },
    {
      id: 'ws-terminal',
      anchor: 'ws-terminal',
      i18nKey: 'tours.workspace.terminal',
      clickTarget: 'ws-tabnav-terminal',
      beforeShow: () => openRightTab('ws-tabnav-terminal', 'ws-terminal'),
    },
  ],
}
