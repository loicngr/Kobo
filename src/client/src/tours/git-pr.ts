import { useLayoutStore } from 'src/stores/layout'
import { useWorkspaceStore } from 'src/stores/workspace'
import { anchorPresent, clickAnchor } from './dom'
import type { TourDefinition, TourStep } from './types'

function hasOpenPr(): boolean {
  const store = useWorkspaceStore()
  const id = store.selectedWorkspaceId
  return !!id && store.prSnapshots[id]?.state === 'OPEN'
}

/** Every Git-tab step opens the right drawer and the Git tab first. */
function gitStep(id: string, anchor: string, i18nKey: string, when: () => boolean, gate?: 'dom'): TourStep {
  return {
    id,
    anchor,
    i18nKey,
    when,
    ...(gate ? { gate } : {}),
    clickTarget: 'ws-tabnav-git',
    beforeShow: async () => {
      useLayoutStore().setRight(true)
      return clickAnchor('ws-tabnav-git', anchor)
    },
  }
}

export const gitPrTour: TourDefinition = {
  id: 'git-pr',
  route: 'workspace',
  i18nKey: 'tours.gitPr',
  steps: [
    gitStep('pr-panel', 'git-pr-panel', 'tours.gitPr.panel', hasOpenPr),
    // `git-actions` is rendered only once git stats exist. `when` runs before
    // `beforeShow` opens the Git tab, and keep-alive mounts the panel only after
    // its first activation: if `ws-tab-git` has never rendered we cannot know,
    // so the step is let through and only dropped when the panel is up without it.
    gitStep(
      'pr-actions',
      'git-actions',
      'tours.gitPr.actions',
      () => !anchorPresent('ws-tab-git') || anchorPresent('git-actions'),
      'dom',
    ),
    // Anchored on the left list: open that drawer instead of a tab. Gated like the
    // PR card so the tour keeps one scope (an open PR) from the Help menu.
    {
      id: 'pr-after',
      anchor: 'workspace-list',
      i18nKey: 'tours.gitPr.attention',
      when: hasOpenPr,
      beforeShow: async () => useLayoutStore().setLeft(true),
    },
  ],
}
