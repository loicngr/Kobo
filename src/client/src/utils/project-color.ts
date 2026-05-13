import { useSettingsStore } from 'src/stores/settings'
import type { Workspace } from 'src/stores/workspace'

/**
 * Curated palette for per-project colours. Mirrors `src/shared/project-colors.ts`
 * on the backend. Kept in sync manually — the two files are short.
 */
export const PROJECT_COLOR_PALETTE = [
  'red-5',
  'pink-5',
  'purple-5',
  'deep-purple-5',
  'indigo-5',
  'blue-5',
  'cyan-5',
  'teal-5',
  'green-5',
  'amber-5',
  'orange-5',
  'brown-5',
] as const

export type ProjectColor = (typeof PROJECT_COLOR_PALETTE)[number]

/**
 * Hand-tuned foreground colour for each palette entry — `pickReadableForeground`
 * works on raw hex, but Quasar colour keys are evaluated at render time, so we
 * pre-compute the contrast value per key.
 */
export const PROJECT_COLOR_TEXT_CONTRAST: Record<ProjectColor, 'white' | 'grey-9'> = {
  'red-5': 'white',
  'pink-5': 'white',
  'purple-5': 'white',
  'deep-purple-5': 'white',
  'indigo-5': 'white',
  'blue-5': 'white',
  'cyan-5': 'grey-9',
  'teal-5': 'white',
  'green-5': 'grey-9',
  'amber-5': 'grey-9',
  'orange-5': 'white',
  'brown-5': 'white',
}

export function projectColorFor(workspace: Workspace): ProjectColor | null {
  const store = useSettingsStore()
  const proj = store.getProjectByPath(workspace.projectPath)
  return proj?.color ?? null
}

export function projectNameForPath(projectPath: string): string {
  const store = useSettingsStore()
  const proj = store.getProjectByPath(projectPath)
  const display = proj?.displayName?.trim()
  if (display) return display
  return basenameOf(projectPath)
}

export function projectNameFor(workspace: Workspace): string {
  return projectNameForPath(workspace.projectPath)
}

export function projectTextColorFor(workspace: Workspace): string {
  const color = projectColorFor(workspace)
  if (!color) return 'grey-3'
  return PROJECT_COLOR_TEXT_CONTRAST[color]
}

function basenameOf(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() ?? p
}
