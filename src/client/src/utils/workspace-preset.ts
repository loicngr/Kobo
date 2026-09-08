/**
 * The bridge between the create form and a saved preset.
 *
 * Templates, duplication and the Settings view all go through these two
 * functions, so the set of fields a preset can carry is defined in exactly one
 * place - here - and the two directions are tested against each other.
 *
 * Blank means unset in both directions: `capturePreset` trims strings before
 * storing them and drops fields that trim to empty, and `applyPreset` only
 * overwrites a form field when the preset's value is non-blank after
 * trimming - a blank field on the preset leaves the form's current value
 * untouched rather than clearing it.
 */

import type { AgentPermissionMode } from 'src/constants/permissionModes'

export type { AgentPermissionMode }

/** Mirror of the server's WorkspacePreset (workspace-template-service.ts). */
export interface WorkspacePreset {
  projectPath?: string
  sourceBranch?: string
  branchType?: string
  engine?: string
  model?: string
  reasoningEffort?: string
  agentPermissionMode?: AgentPermissionMode
  autoLoop?: boolean
  autoLoopSessionMode?: 'per_task' | 'continuous'
  brainstormModel?: string
  brainstormReasoningEffort?: string
  skipSetupScript?: boolean
  description?: string
  tasks?: string[]
  acceptanceCriteria?: string[]
}

/** The slice of the create form a preset can describe. Plain values, no refs. */
export interface PresetFormState {
  projectPath: string
  sourceBranch: string
  branchType: string
  engine: string
  model: string
  reasoningEffort: string
  agentPermissionMode: AgentPermissionMode
  autoLoop: boolean
  autoLoopSessionMode: 'per_task' | 'continuous'
  brainstormModel: string
  brainstormReasoningEffort: string
  skipSetupScript: boolean
  description: string
  tasks: string[]
  acceptanceCriteria: string[]
}

const STRING_FIELDS = [
  'projectPath',
  'sourceBranch',
  'branchType',
  'engine',
  'model',
  'reasoningEffort',
  'brainstormModel',
  'brainstormReasoningEffort',
  'description',
] as const

/** Blank strings and empty lists are "unset", not values worth saving. */
export function capturePreset(form: PresetFormState): WorkspacePreset {
  const preset: WorkspacePreset = {}
  for (const key of STRING_FIELDS) {
    const trimmed = form[key].trim()
    if (trimmed) preset[key] = trimmed
  }
  preset.agentPermissionMode = form.agentPermissionMode
  preset.autoLoop = form.autoLoop
  preset.autoLoopSessionMode = form.autoLoopSessionMode
  preset.skipSetupScript = form.skipSetupScript
  if (form.tasks.length > 0) preset.tasks = [...form.tasks]
  if (form.acceptanceCriteria.length > 0) preset.acceptanceCriteria = [...form.acceptanceCriteria]
  return preset
}

/** A new form state where only the keys present in the preset changed. */
export function applyPreset(form: PresetFormState, preset: WorkspacePreset): PresetFormState {
  const next: PresetFormState = { ...form, tasks: [...form.tasks], acceptanceCriteria: [...form.acceptanceCriteria] }
  for (const key of STRING_FIELDS) {
    const value = preset[key]
    if (typeof value === 'string' && value.trim()) next[key] = value
  }
  if (preset.agentPermissionMode !== undefined) next.agentPermissionMode = preset.agentPermissionMode
  if (preset.autoLoop !== undefined) next.autoLoop = preset.autoLoop
  if (preset.autoLoopSessionMode !== undefined) next.autoLoopSessionMode = preset.autoLoopSessionMode
  if (preset.skipSetupScript !== undefined) next.skipSetupScript = preset.skipSetupScript
  if (preset.tasks !== undefined) next.tasks = [...preset.tasks]
  if (preset.acceptanceCriteria !== undefined) next.acceptanceCriteria = [...preset.acceptanceCriteria]
  return next
}
