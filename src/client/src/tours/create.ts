import { anchorPresent } from './dom'
import type { TourDefinition } from './types'

/** Steps follow the form top to bottom. */
export const createTour: TourDefinition = {
  id: 'create',
  route: 'create',
  i18nKey: 'tours.create',
  steps: [
    { id: 'create-template', anchor: 'create-template', i18nKey: 'tours.create.template' },
    { id: 'create-mission', anchor: 'create-mission', i18nKey: 'tours.create.mission' },
    { id: 'create-project', anchor: 'create-project', i18nKey: 'tours.create.project' },
    { id: 'create-engine', anchor: 'create-engine', i18nKey: 'tours.create.engine' },
    { id: 'create-autoloop', anchor: 'create-autoloop', i18nKey: 'tours.create.autoloop' },
    {
      id: 'create-comparison',
      anchor: 'create-comparison',
      i18nKey: 'tours.create.comparison',
      // The comparison toggle only renders with more than one engine installed.
      when: () => anchorPresent('create-comparison'),
      gate: 'dom',
    },
    {
      id: 'create-brainstorm',
      anchor: 'create-brainstorm',
      i18nKey: 'tours.create.brainstorm',
      // The brainstorm model pickers only render when auto-loop is on; the step
      // is skipped (not marked seen) until then and shows up on a later run.
      when: () => anchorPresent('create-brainstorm'),
      gate: 'dom',
    },
  ],
}
