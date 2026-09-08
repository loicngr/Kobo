import type { TourDefinition } from './types'

export const dashboardTour: TourDefinition = {
  id: 'dashboard',
  route: 'dashboard',
  i18nKey: 'tours.dashboard',
  steps: [
    { id: 'dash-overview', anchor: 'dash-overview', i18nKey: 'tours.dashboard.overview' },
    { id: 'dash-reliability', anchor: 'dash-reliability', i18nKey: 'tours.dashboard.reliability' },
  ],
}
