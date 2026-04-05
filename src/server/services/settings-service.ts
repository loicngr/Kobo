import fs from 'node:fs'
import path from 'node:path'
import { getSettingsPath } from '../utils/paths.js'

const DEFAULT_GIT_CONVENTIONS = `# Git conventions

## Commits
- Use Conventional Commits: \`type(scope): subject\`
- Types: feat, fix, docs, style, refactor, test, chore, perf, build, ci
- Subject: imperative mood, lowercase, no trailing period, max 72 chars
- Body: wrap at 72 chars, explain *why* not *what*
- Reference issues with \`Refs #123\` or \`Closes #123\`

## Branches
- Feature: \`feature/<short-kebab-case>\`
- Fix: \`fix/<short-kebab-case>\`
- Never commit directly to main/master/develop

## Workflow
- Rebase on the source branch before opening a PR, do not merge it in
- Keep commits atomic and self-contained (each compiles and passes tests)
- Squash fixup commits before pushing
- Never force-push to shared branches

## Safety
- Never run destructive commands (reset --hard, push --force, clean -fd) without explicit user confirmation
- Never skip hooks (--no-verify) unless the user explicitly asks
- Always inspect \`git status\` and \`git diff\` before staging
`

const DEFAULT_PR_PROMPT_TEMPLATE = `A pull request has been opened: {{pr_url}} (#{{pr_number}})

Context:
- Workspace: {{workspace_name}}
- Project: {{project_name}}
- Branch: \`{{branch_name}}\` → \`{{source_branch}}\`
- Notion: {{notion_url}}

Changes:
{{diff_stats}}

Commits:
{{commits}}

Tasks:
{{tasks}}

Acceptance criteria:
{{acceptance_criteria}}

Please:
1. Review the PR description on GitHub and improve it if needed (add a proper summary, screenshots if relevant, a test plan)
2. Verify that all acceptance criteria are checked
3. Post a comment on the PR summarizing what was done and any follow-up items
`

export interface DevServerConfig {
  startCommand: string
  stopCommand: string
}

export interface ProjectSettings {
  path: string
  displayName: string
  defaultSourceBranch: string
  defaultModel: string
  prPromptTemplate: string
  gitConventions: string
  devServer: DevServerConfig
}

export interface GlobalSettings {
  defaultModel: string
  prPromptTemplate: string
  gitConventions: string
}

export interface Settings {
  schemaVersion: number
  global: GlobalSettings
  projects: ProjectSettings[]
}

/**
 * Bump when adding/removing/renaming fields in Settings that require a migration.
 * Each bump must come with a corresponding entry in `runSettingsMigrations()`.
 * Append-only — never renumber shipped versions.
 */
export const SETTINGS_SCHEMA_VERSION = 1

export interface EffectiveSettings {
  model: string
  prPromptTemplate: string
  gitConventions: string
  sourceBranch: string
  devServer: DevServerConfig | null
}

let settingsFilePath = getSettingsPath()

/** Override the settings file path (used by tests). */
export function _setSettingsPath(p: string): void {
  settingsFilePath = p
}

function defaultSettings(): Settings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    global: {
      defaultModel: 'auto',
      prPromptTemplate: DEFAULT_PR_PROMPT_TEMPLATE,
      gitConventions: DEFAULT_GIT_CONVENTIONS,
    },
    projects: [],
  }
}

function defaultProjectSettings(projectPath: string): ProjectSettings {
  return {
    path: projectPath,
    displayName: '',
    defaultSourceBranch: '',
    defaultModel: '',
    prPromptTemplate: '',
    gitConventions: '',
    devServer: {
      startCommand: '',
      stopCommand: '',
    },
  }
}

function pickKnownKeys<T>(data: Record<string, unknown>, allowedKeys: string[]): Partial<T> {
  return Object.fromEntries(Object.entries(data).filter(([key]) => allowedKeys.includes(key))) as Partial<T>
}

/**
 * Apply migrations sequentially to bring an older settings object up to
 * SETTINGS_SCHEMA_VERSION. Each migration is append-only — never edit or
 * reorder shipped migrations. The returned object carries the bumped
 * schemaVersion; callers should persist it back to disk.
 */
export function runSettingsMigrations(raw: Record<string, unknown>): Settings {
  // Ensure a baseline shape so we can safely read .global and .projects
  const current = raw as {
    schemaVersion?: number
    global?: Record<string, unknown>
    projects?: unknown[]
  }
  if (!current.global || typeof current.global !== 'object') {
    current.global = {}
  }
  if (!Array.isArray(current.projects)) {
    current.projects = []
  }

  // Detect legacy (pre-versioned) settings as v0
  let version = typeof current.schemaVersion === 'number' ? current.schemaVersion : 0

  // ── v0 → v1: ensure gitConventions field exists on global and every project
  if (version < 1) {
    if (typeof current.global.gitConventions !== 'string') {
      current.global.gitConventions = ''
    }
    for (const p of current.projects as Array<Record<string, unknown>>) {
      if (typeof p.gitConventions !== 'string') p.gitConventions = ''
    }
    version = 1
  }

  // Future migrations go here — increment SETTINGS_SCHEMA_VERSION in lockstep.

  current.schemaVersion = version
  return current as unknown as Settings
}

function readSettings(): Settings {
  if (!fs.existsSync(settingsFilePath)) {
    const defaults = defaultSettings()
    writeSettings(defaults)
    return defaults
  }

  const raw = fs.readFileSync(settingsFilePath, 'utf-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    const defaults = defaultSettings()
    writeSettings(defaults)
    return defaults
  }
  if (!parsed || typeof parsed !== 'object') {
    const defaults = defaultSettings()
    writeSettings(defaults)
    return defaults
  }

  const originalVersion = (parsed as { schemaVersion?: number }).schemaVersion
  const migrated = runSettingsMigrations(parsed as Record<string, unknown>)

  // If migrations bumped the version, persist the upgraded settings so the
  // next process doesn't re-run them on every load.
  if (migrated.schemaVersion !== originalVersion) {
    writeSettings(migrated)
  }

  return migrated
}

function writeSettings(settings: Settings): void {
  const tmpPath = `${settingsFilePath}.tmp`
  const dir = path.dirname(settingsFilePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2), 'utf-8')
  fs.renameSync(tmpPath, settingsFilePath)
}

export function getSettings(): Settings {
  return readSettings()
}

export function getGlobalSettings(): GlobalSettings {
  return readSettings().global
}

export function getProjectSettings(projectPath: string): ProjectSettings | null {
  const settings = readSettings()
  return settings.projects.find((p) => p.path === projectPath) ?? null
}

export function getEffectiveSettings(projectPath: string): EffectiveSettings {
  const settings = readSettings()
  const project = settings.projects.find((p) => p.path === projectPath) ?? null

  if (!project) {
    return {
      model: settings.global.defaultModel,
      prPromptTemplate: settings.global.prPromptTemplate,
      gitConventions: settings.global.gitConventions,
      sourceBranch: '',
      devServer: null,
    }
  }

  return {
    model: project.defaultModel || settings.global.defaultModel,
    prPromptTemplate: project.prPromptTemplate || settings.global.prPromptTemplate,
    gitConventions: project.gitConventions || settings.global.gitConventions,
    sourceBranch: project.defaultSourceBranch,
    devServer: project.devServer,
  }
}

export function updateGlobalSettings(data: Partial<GlobalSettings>): GlobalSettings {
  const settings = readSettings()
  const allowedGlobalKeys = ['defaultModel', 'prPromptTemplate', 'gitConventions']
  const filtered = pickKnownKeys<GlobalSettings>(data as Record<string, unknown>, allowedGlobalKeys)
  settings.global = { ...settings.global, ...filtered }
  writeSettings(settings)
  return settings.global
}

export function upsertProject(projectPath: string, data: Partial<Omit<ProjectSettings, 'path'>>): ProjectSettings {
  const allowedProjectKeys = [
    'displayName',
    'defaultSourceBranch',
    'defaultModel',
    'prPromptTemplate',
    'gitConventions',
    'devServer',
  ]
  const allowedDevServerKeys = ['startCommand', 'stopCommand']
  const filtered = pickKnownKeys<Omit<ProjectSettings, 'path'>>(data as Record<string, unknown>, allowedProjectKeys)
  if (filtered.devServer) {
    filtered.devServer = pickKnownKeys<DevServerConfig>(
      filtered.devServer as unknown as Record<string, unknown>,
      allowedDevServerKeys,
    ) as DevServerConfig
  }

  const settings = readSettings()
  const idx = settings.projects.findIndex((p) => p.path === projectPath)

  if (idx >= 0) {
    // Update existing project — merge devServer separately to allow partial updates
    const existing = settings.projects[idx]
    const updatedDevServer = filtered.devServer ? { ...existing.devServer, ...filtered.devServer } : existing.devServer
    settings.projects[idx] = {
      ...existing,
      ...filtered,
      path: projectPath,
      devServer: updatedDevServer,
    }
  } else {
    // Add new project
    const newProject: ProjectSettings = {
      ...defaultProjectSettings(projectPath),
      ...filtered,
      path: projectPath,
    }
    if (filtered.devServer) {
      newProject.devServer = { ...defaultProjectSettings(projectPath).devServer, ...filtered.devServer }
    }
    settings.projects.push(newProject)
  }

  writeSettings(settings)
  return settings.projects.find((p) => p.path === projectPath) as ProjectSettings
}

export function deleteProject(projectPath: string): void {
  const settings = readSettings()
  settings.projects = settings.projects.filter((p) => p.path !== projectPath)
  writeSettings(settings)
}

export function listProjects(): ProjectSettings[] {
  return readSettings().projects
}
