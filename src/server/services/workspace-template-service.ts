import { existsSync, readFileSync } from 'node:fs'
import { nanoid } from 'nanoid'
import { getDb } from '../db/index.js'
import { writeJsonFileAtomically } from '../utils/atomic-json-file.js'
import { getWorkspaceTemplatesPath } from '../utils/paths.js'
import { getGlobalSettings } from './settings-service.js'
import type { AgentPermissionMode } from './workspace-service.js'

/**
 * A named preset of the create-workspace form.
 *
 * Every field is optional: a template carries what was set when it was saved,
 * and applying it leaves the other form fields alone. The workspace name, the
 * working branch (derived at each creation) and the Notion / Sentry / PR URLs
 * (one-off context) are deliberately not part of it.
 */
export interface WorkspacePreset {
  projectPath?: string
  sourceBranch?: string
  /** The branch prefix without its '/', e.g. 'feature'. */
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
  tags?: string[]
}

export interface WorkspaceTemplate {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  preset: WorkspacePreset
}

interface WorkspaceTemplatesFile {
  version: number
  templates: WorkspaceTemplate[]
}

const FILE_VERSION = 1
export const MAX_WORKSPACE_TEMPLATES = 100
const MAX_NAME_LENGTH = 80

const STRING_KEYS = [
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
const BOOLEAN_KEYS = ['autoLoop', 'skipSetupScript'] as const
const LIST_KEYS = ['tasks', 'acceptanceCriteria'] as const
const PERMISSION_MODES = ['plan', 'bypass', 'strict', 'interactive'] as const
const SESSION_MODES = ['per_task', 'continuous'] as const

/**
 * Keep the known keys that carry the right type, drop everything else. An
 * unknown or malformed field is not a reason to refuse a whole template — a
 * hand-edited file or an older client should degrade to "that field is
 * unset", not to an error.
 */
export function sanitizePreset(input: unknown): WorkspacePreset {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {}
  const raw = input as Record<string, unknown>
  const preset: WorkspacePreset = {}
  for (const key of STRING_KEYS) {
    if (typeof raw[key] === 'string') preset[key] = raw[key]
  }
  for (const key of BOOLEAN_KEYS) {
    if (typeof raw[key] === 'boolean') preset[key] = raw[key]
  }
  for (const key of LIST_KEYS) {
    if (Array.isArray(raw[key])) preset[key] = raw[key].filter((v): v is string => typeof v === 'string')
  }
  if (Array.isArray(raw.tags)) {
    preset.tags = [
      ...new Set(
        raw.tags
          .filter((tag): tag is string => typeof tag === 'string')
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0 && tag.length <= 50),
      ),
    ]
  }
  if (
    typeof raw.agentPermissionMode === 'string' &&
    (PERMISSION_MODES as readonly string[]).includes(raw.agentPermissionMode)
  ) {
    preset.agentPermissionMode = raw.agentPermissionMode as WorkspacePreset['agentPermissionMode']
  }
  if (
    typeof raw.autoLoopSessionMode === 'string' &&
    (SESSION_MODES as readonly string[]).includes(raw.autoLoopSessionMode)
  ) {
    preset.autoLoopSessionMode = raw.autoLoopSessionMode as WorkspacePreset['autoLoopSessionMode']
  }
  return preset
}

function normalizeName(name: string): string {
  return name.trim()
}

function assertValidName(name: string): void {
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new Error(`Invalid template name: must be 1 to ${MAX_NAME_LENGTH} characters`)
  }
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function readFile(): WorkspaceTemplate[] {
  const filePath = getWorkspaceTemplatesPath()
  if (!existsSync(filePath)) return []
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as WorkspaceTemplatesFile | null
    if (!parsed || !Array.isArray(parsed.templates)) throw new Error('Expected a templates array')
    if (parsed.version !== FILE_VERSION) {
      console.warn(
        `[workspace-template-service] workspace-templates.json has version ${parsed.version}, expected ${FILE_VERSION}. Reading best-effort.`,
      )
    }
    if (
      parsed.templates.some(
        (t) =>
          !t ||
          typeof t.id !== 'string' ||
          typeof t.name !== 'string' ||
          typeof t.createdAt !== 'string' ||
          typeof t.updatedAt !== 'string',
      )
    ) {
      throw new Error('A workspace template has missing or malformed fields')
    }
    // Re-sanitise on read: the file may have been edited by hand.
    return parsed.templates.map((t) => ({ ...t, preset: sanitizePreset(t.preset) }))
  } catch (err) {
    throw new Error('Failed to read workspace-templates.json. Existing data was preserved; restore a valid file.', {
      cause: err,
    })
  }
}

function writeFile(templates: WorkspaceTemplate[]): void {
  const file: WorkspaceTemplatesFile = { version: FILE_VERSION, templates }
  writeJsonFileAtomically(getWorkspaceTemplatesPath(), file)
}

export function listWorkspaceTemplates(): WorkspaceTemplate[] {
  return readFile().map((template) => ({ ...template, preset: sanitizeTemplatePreset(template.preset) }))
}

/** Guard writes from stale clients as well as reads of hand-edited/older files. */
function sanitizeTemplatePreset(input: unknown): WorkspacePreset {
  const preset = sanitizePreset(input)
  if (preset.tags !== undefined) {
    const allowed = new Set(getGlobalSettings().tags)
    preset.tags = preset.tags.filter((tag) => allowed.has(tag))
  }
  return preset
}

/** Called before persisting a changed catalogue; a corrupt file aborts deletion. */
export function pruneWorkspaceTemplateTags(allowedTags: readonly string[]): void {
  const allowed = new Set(allowedTags)
  let changed = false
  const templates = readFile().map((template) => {
    if (template.preset.tags === undefined) return template
    const tags = template.preset.tags.filter((tag) => allowed.has(tag))
    if (tags.length === template.preset.tags.length) return template
    changed = true
    return { ...template, preset: { ...template.preset, tags }, updatedAt: new Date().toISOString() }
  })
  if (changed) writeFile(templates)
}

/** Throws `Invalid template name`, `already exists` or `Too many templates`. */
export function createWorkspaceTemplate(input: { name: string; preset: unknown }): WorkspaceTemplate {
  const name = normalizeName(input.name)
  assertValidName(name)
  const templates = readFile()
  if (templates.some((t) => sameName(t.name, name))) {
    throw new Error(`Template '${name}' already exists`)
  }
  if (templates.length >= MAX_WORKSPACE_TEMPLATES) {
    throw new Error(`Too many templates: the limit is ${MAX_WORKSPACE_TEMPLATES}`)
  }
  const now = new Date().toISOString()
  const template: WorkspaceTemplate = {
    id: nanoid(),
    name,
    createdAt: now,
    updatedAt: now,
    preset: sanitizeTemplatePreset(input.preset),
  }
  writeFile([...templates, template])
  return template
}

/** Null for an unknown id. Throws on an invalid or duplicate name. */
export function updateWorkspaceTemplate(
  id: string,
  updates: { name?: string; preset?: unknown },
): WorkspaceTemplate | null {
  const templates = readFile()
  const index = templates.findIndex((t) => t.id === id)
  if (index < 0) return null
  const current = templates[index]
  let name = current.name
  if (updates.name !== undefined) {
    name = normalizeName(updates.name)
    assertValidName(name)
    if (templates.some((t) => t.id !== id && sameName(t.name, name))) {
      throw new Error(`Template '${name}' already exists`)
    }
  }
  const updated: WorkspaceTemplate = {
    ...current,
    name,
    preset: sanitizeTemplatePreset(updates.preset !== undefined ? updates.preset : current.preset),
    updatedAt: new Date().toISOString(),
  }
  templates[index] = updated
  writeFile(templates)
  return updated
}

/** False for an unknown id. */
export function deleteWorkspaceTemplate(id: string): boolean {
  const templates = readFile()
  const remaining = templates.filter((t) => t.id !== id)
  if (remaining.length === templates.length) return false
  writeFile(remaining)
  return true
}

interface PresetWorkspaceRow {
  project_path: string
  source_branch: string
  working_branch: string
  engine: string
  model: string
  reasoning_effort: string
  agent_permission_mode: string
  auto_loop: number
  auto_loop_session_mode: string
  brainstorm_model: string | null
  description: string | null
}

/**
 * The preset an existing workspace would have been created from. Used by
 * "Duplicate": the create form is prefilled with it, nothing is written.
 * Tasks and criteria come back as titles in their order, statuses dropped — a
 * preset describes work to do, not work done.
 */
export function presetFromWorkspace(workspaceId: string): WorkspacePreset | null {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT project_path, source_branch, working_branch, engine, model, reasoning_effort,
              agent_permission_mode, auto_loop, auto_loop_session_mode, brainstorm_model, description
         FROM workspaces WHERE id = ?`,
    )
    .get(workspaceId) as PresetWorkspaceRow | undefined
  if (!row) return null

  const tasks = db
    .prepare('SELECT title, is_acceptance_criterion FROM tasks WHERE workspace_id = ? ORDER BY sort_order ASC')
    .all(workspaceId) as Array<{ title: string; is_acceptance_criterion: number }>

  const slash = row.working_branch.indexOf('/')
  const preset: WorkspacePreset = {
    projectPath: row.project_path,
    sourceBranch: row.source_branch,
    ...(slash > 0 ? { branchType: row.working_branch.slice(0, slash) } : {}),
    engine: row.engine,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    autoLoop: row.auto_loop === 1,
    ...(row.brainstorm_model ? { brainstormModel: row.brainstorm_model } : {}),
    ...(row.description ? { description: row.description } : {}),
    tasks: tasks.filter((t) => t.is_acceptance_criterion !== 1).map((t) => t.title),
    acceptanceCriteria: tasks.filter((t) => t.is_acceptance_criterion === 1).map((t) => t.title),
  }
  // Route the enum-like columns through the sanitiser so a legacy value in the
  // DB cannot leak an out-of-range mode into the form.
  return {
    ...preset,
    ...sanitizePreset({
      agentPermissionMode: row.agent_permission_mode,
      autoLoopSessionMode: row.auto_loop_session_mode,
    }),
  }
}
