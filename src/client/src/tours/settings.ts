import { anchorPresent, clickAnchor } from './dom'
import type { TourDefinition, TourStep } from './types'

/**
 * Settings tabs grouped by theme. Every tab id from `navItems` in
 * `SettingsPage.vue` must appear in exactly one group; the registry test
 * enforces it, so adding a tab without a group fails the suite. The first
 * tab of each group is the one the step anchors on.
 */
export const SETTINGS_GROUPS = {
  engines: ['agents'],
  integrations: ['notion', 'sentry', 'forge'],
  automation: ['scripts', 'prompts', 'templates', 'workspaceTemplates', 'skills'],
  worktrees: ['worktrees'],
  projects: ['projects'],
  misc: ['general', 'voice', 'notifications', 'export'],
} as const satisfies Record<string, readonly [string, ...string[]]>

export type SettingsGroup = keyof typeof SETTINGS_GROUPS

function groupStep(group: SettingsGroup): TourStep {
  const firstTab = SETTINGS_GROUPS[group][0]
  return {
    id: `settings-${group}`,
    anchor: `settings-card-${firstTab}`,
    i18nKey: `tours.settings.${group}`,
    clickTarget: `settings-nav-${firstTab}`,
    beforeShow: () => clickAnchor(`settings-nav-${firstTab}`, `settings-card-${firstTab}`),
  }
}

export const settingsTour: TourDefinition = {
  id: 'settings',
  route: 'settings',
  i18nKey: 'tours.settings',
  steps: [
    ...(Object.keys(SETTINGS_GROUPS) as SettingsGroup[]).map(groupStep),
    {
      id: 'settings-mcp',
      anchor: 'settings-mcp',
      i18nKey: 'tours.settings.mcp',
      clickTarget: 'settings-nav-general',
      beforeShow: () => clickAnchor('settings-nav-general', 'settings-mcp'),
      // The tab switch renders the panel in beforeShow; gate on its available navigation.
      when: () => anchorPresent('settings-nav-general'),
      gate: 'dom',
    },
  ],
}
