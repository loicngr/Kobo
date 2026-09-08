import type { TourDefinition } from './types'

export const healthTour: TourDefinition = {
  id: 'health',
  route: 'health',
  i18nKey: 'tours.health',
  steps: [
    { id: 'health-checks', anchor: 'health-checks', i18nKey: 'tours.health.checks' },
    { id: 'health-active', anchor: 'health-active', i18nKey: 'tours.health.active' },
  ],
}

export const searchTour: TourDefinition = {
  id: 'search',
  route: 'search',
  i18nKey: 'tours.search',
  steps: [
    { id: 'search-input', anchor: 'search-input', i18nKey: 'tours.search.input' },
    { id: 'search-archived', anchor: 'search-archived', i18nKey: 'tours.search.archived' },
  ],
}

export const changelogTour: TourDefinition = {
  id: 'changelog',
  route: 'changelog',
  i18nKey: 'tours.changelog',
  steps: [{ id: 'changelog-list', anchor: 'changelog-list', i18nKey: 'tours.changelog.list' }],
}
