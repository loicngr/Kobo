import type { TourDefinition } from './types'
export const splitTour: TourDefinition = {
  id: 'split',
  route: 'split',
  i18nKey: 'split',
  steps: [{ id: 'split-controls', anchor: 'split-controls', i18nKey: 'tours.split.controls' }],
}
