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
4. Do NOT add a "Generated with Claude Code" footer or any AI attribution to the PR description
`

/** Dev-server start/stop commands for a project. */
export interface DevServerConfig {
  startCommand: string
  stopCommand: string
}

/** Per-project settings, stored in settings.json. */
export interface ProjectSettings {
  path: string
  displayName: string
  defaultSourceBranch: string
  defaultModel: string
  dangerouslySkipPermissions: boolean
  prPromptTemplate: string
  gitConventions: string
  setupScript: string
  notionStatusProperty: string
  notionInProgressStatus: string
  devServer: DevServerConfig
}

/** Global settings that apply as defaults when no project override is set. */
export interface GlobalSettings {
  defaultModel: string
  dangerouslySkipPermissions: boolean
  prPromptTemplate: string
  gitConventions: string
  editorCommand: string
  browserNotifications: boolean
  audioNotifications: boolean
  notionStatusProperty: string
  notionInProgressStatus: string
  defaultPermissionMode: string
}

/** Top-level settings structure persisted to settings.json. */
export interface Settings {
  schemaVersion: number
  global: GlobalSettings
  projects: ProjectSettings[]
}

// ── Settings migration registry ───────────────────────────────────────────────
// Each entry describes a single settings upgrade step.
// Append-only — never edit or reorder shipped entries.

interface SettingsMigration {
  version: number
  name: string
  migrate: (current: { global: Record<string, unknown>; projects: Array<Record<string, unknown>> }) => void
}

const settingsMigrations: SettingsMigration[] = [
  {
    version: 1,
    name: 'add-git-conventions',
    migrate: ({ global, projects }) => {
      if (typeof global.gitConventions !== 'string') global.gitConventions = ''
      for (const p of projects) {
        if (typeof p.gitConventions !== 'string') p.gitConventions = ''
      }
    },
  },
  {
    version: 2,
    name: 'add-dangerously-skip-permissions',
    migrate: ({ global, projects }) => {
      if (typeof global.dangerouslySkipPermissions !== 'boolean') global.dangerouslySkipPermissions = true
      for (const p of projects) {
        if (typeof p.dangerouslySkipPermissions !== 'boolean') p.dangerouslySkipPermissions = true
      }
    },
  },
  {
    version: 3,
    name: 'add-setup-script',
    migrate({ projects }) {
      for (const project of projects) {
        if (!('setupScript' in project)) {
          ;(project as Record<string, unknown>).setupScript = ''
        }
      }
    },
  },
  {
    version: 4,
    name: 'add-editor-and-notifications',
    migrate({ global }) {
      if (typeof global.editorCommand !== 'string') global.editorCommand = ''
      if (typeof global.browserNotifications !== 'boolean') global.browserNotifications = true
      if (typeof global.audioNotifications !== 'boolean') global.audioNotifications = true
    },
  },
  {
    version: 5,
    name: 'add-notion-in-progress-status',
    migrate({ global, projects }) {
      if (typeof global.notionStatusProperty !== 'string') global.notionStatusProperty = ''
      if (typeof global.notionInProgressStatus !== 'string') global.notionInProgressStatus = ''
      for (const p of projects) {
        if (typeof p.notionStatusProperty !== 'string') p.notionStatusProperty = ''
        if (typeof p.notionInProgressStatus !== 'string') p.notionInProgressStatus = ''
      }
    },
  },
  {
    version: 6,
    name: 'add-default-permission-mode',
    migrate({ global }) {
      if (typeof global.defaultPermissionMode !== 'string') global.defaultPermissionMode = 'plan'
    },
  },
]

/** Current settings schema version — always equals the highest migration version. */
export const SETTINGS_SCHEMA_VERSION =
  settingsMigrations.length > 0 ? settingsMigrations[settingsMigrations.length - 1].version : 0

/** Merged settings for a project (project overrides + global defaults). */
export interface EffectiveSettings {
  model: string
  dangerouslySkipPermissions: boolean
  prPromptTemplate: string
  gitConventions: string
  sourceBranch: string
  devServer: DevServerConfig | null
  setupScript: string
  notionStatusProperty: string
  notionInProgressStatus: string
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
      dangerouslySkipPermissions: true,
      prPromptTemplate: DEFAULT_PR_PROMPT_TEMPLATE,
      gitConventions: DEFAULT_GIT_CONVENTIONS,
      editorCommand: '',
      browserNotifications: true,
      audioNotifications: true,
      notionStatusProperty: '',
      notionInProgressStatus: '',
      defaultPermissionMode: 'plan',
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
    dangerouslySkipPermissions: true,
    prPromptTemplate: '',
    gitConventions: '',
    setupScript: '',
    notionInProgressStatus: '',
    notionStatusProperty: '',
    devServer: {
      startCommand: '',
      stopCommand: '',
    },
  }
}

function pickKnownKeys<T>(data: Record<string, unknown>, allowedKeys: string[]): Partial<T> {
  return Object.fromEntries(Object.entries(data).filter(([key]) => allowedKeys.includes(key))) as Partial<T>
}

/** Apply settings migrations sequentially up to SETTINGS_SCHEMA_VERSION. Append-only. */
export function runSettingsMigrations(raw: Record<string, unknown>): Settings {
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

  let version = typeof current.schemaVersion === 'number' ? current.schemaVersion : 0

  for (const m of settingsMigrations) {
    if (version < m.version) {
      m.migrate({ global: current.global, projects: current.projects as Array<Record<string, unknown>> })
      version = m.version
    }
  }

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

/** Read and return the full settings object, creating defaults if missing. */
export function getSettings(): Settings {
  return readSettings()
}

/** Return only the global settings section. */
export function getGlobalSettings(): GlobalSettings {
  return readSettings().global
}

/** Return project-specific settings, or null if the project is not configured. */
export function getProjectSettings(projectPath: string): ProjectSettings | null {
  const settings = readSettings()
  return settings.projects.find((p) => p.path === projectPath) ?? null
}

/** Compute effective settings for a project (project overrides merged with global defaults). */
export function getEffectiveSettings(projectPath: string): EffectiveSettings {
  const settings = readSettings()
  const project = settings.projects.find((p) => p.path === projectPath) ?? null

  if (!project) {
    return {
      model: settings.global.defaultModel,
      dangerouslySkipPermissions: settings.global.dangerouslySkipPermissions,
      prPromptTemplate: settings.global.prPromptTemplate,
      gitConventions: settings.global.gitConventions,
      sourceBranch: '',
      devServer: null,
      setupScript: '',
      notionStatusProperty: settings.global.notionStatusProperty,
      notionInProgressStatus: settings.global.notionInProgressStatus,
    }
  }

  return {
    model: project.defaultModel || settings.global.defaultModel,
    dangerouslySkipPermissions: project.dangerouslySkipPermissions ?? settings.global.dangerouslySkipPermissions,
    prPromptTemplate: project.prPromptTemplate || settings.global.prPromptTemplate,
    gitConventions: project.gitConventions || settings.global.gitConventions,
    sourceBranch: project.defaultSourceBranch,
    devServer: project.devServer,
    setupScript: project.setupScript || '',
    notionStatusProperty: project.notionStatusProperty || settings.global.notionStatusProperty,
    notionInProgressStatus: project.notionInProgressStatus || settings.global.notionInProgressStatus,
  }
}

/** Merge partial updates into global settings and persist. */
export function updateGlobalSettings(data: Partial<GlobalSettings>): GlobalSettings {
  const settings = readSettings()
  const allowedGlobalKeys = [
    'defaultModel',
    'dangerouslySkipPermissions',
    'prPromptTemplate',
    'gitConventions',
    'editorCommand',
    'browserNotifications',
    'audioNotifications',
    'notionStatusProperty',
    'notionInProgressStatus',
    'defaultPermissionMode',
  ]
  const filtered = pickKnownKeys<GlobalSettings>(data as Record<string, unknown>, allowedGlobalKeys)
  settings.global = { ...settings.global, ...filtered }
  writeSettings(settings)
  return settings.global
}

/** Create or update project-specific settings. Merges devServer fields on update. */
export function upsertProject(projectPath: string, data: Partial<Omit<ProjectSettings, 'path'>>): ProjectSettings {
  const allowedProjectKeys = [
    'displayName',
    'defaultSourceBranch',
    'defaultModel',
    'dangerouslySkipPermissions',
    'prPromptTemplate',
    'gitConventions',
    'setupScript',
    'notionStatusProperty',
    'notionInProgressStatus',
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

/** Remove a project from the settings file. */
export function deleteProject(projectPath: string): void {
  const settings = readSettings()
  settings.projects = settings.projects.filter((p) => p.path !== projectPath)
  writeSettings(settings)
}

/** List all configured projects. */
export function listProjects(): ProjectSettings[] {
  return readSettings().projects
}
