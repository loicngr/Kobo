import type { Router } from 'vue-router'

export type TourId =
  | 'split'
  | 'home'
  | 'create'
  | 'workspace'
  | 'git-pr'
  | 'settings'
  | 'dashboard'
  | 'health'
  | 'search'
  | 'changelog'

export interface TourStep {
  /** Stable id, never renamed once shipped: it is what "seen" state is keyed on. */
  id: string
  /** `data-tour` attribute value of the anchor (without selector syntax). */
  anchor: string
  /** i18n prefix; `.title` and `.description` are appended. */
  i18nKey: string
  /** Optional gate evaluated at run time (e.g. "a PR exists"). The step is dropped when false. */
  when?: () => boolean
  /**
   * What `when` depends on. `'state'` (default) reads application state and is applied
   * everywhere, including the Help menu status. `'dom'` reads the rendered page, so the
   * status and the runnable-step count leave the step out instead of guessing.
   */
  gate?: 'state' | 'dom'
  /** Optional preparation (open a tab, ...); its result is ignored, the engine then waits for the anchor to be visible. */
  beforeShow?: () => Promise<unknown>
  /** `data-tour` value that `beforeShow` clicks, so the registry test can check it exists. */
  clickTarget?: string
}

export interface TourDefinition {
  id: TourId
  /** Route name the tour lives on; the Help menu navigates there before running it. */
  route: string
  /** i18n key of the tour's title, shown in the Help menu. */
  i18nKey: string
  steps: TourStep[]
  /** Runs when the user reaches the last step and closes the tour (not on abandon). */
  onDone?: (router: Router) => void
}

export type TourStatus = 'unseen' | 'partial' | 'seen'

export interface RunOptions {
  onlyUnseen?: boolean
}
