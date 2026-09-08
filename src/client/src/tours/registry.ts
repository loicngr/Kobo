import { createTour } from './create'
import { dashboardTour } from './dashboard'
import { gitPrTour } from './git-pr'
import { homeTour } from './home'
import { settingsTour } from './settings'
import { changelogTour, healthTour, searchTour } from './small'
import type { TourDefinition, TourId } from './types'
import { workspaceTour } from './workspace'

/** Order is the Help menu order. */
export const TOURS: readonly TourDefinition[] = [
  homeTour,
  createTour,
  workspaceTour,
  gitPrTour,
  settingsTour,
  dashboardTour,
  healthTour,
  searchTour,
  changelogTour,
]

export function findTour(id: TourId): TourDefinition | undefined {
  return TOURS.find((t) => t.id === id)
}
