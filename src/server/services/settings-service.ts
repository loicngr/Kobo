import fs from 'node:fs'
import path from 'node:path'
import { listClaudeMcpEntries } from '../utils/mcp-client.js'
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

/** E2E testing configuration for a project. */
export interface E2eSettings {
  framework: 'cypress' | 'playwright' | 'jest' | 'vitest' | 'other' | ''
  skill: string
  prompt: string
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
  devServer: DevServerConfig
  e2e: E2eSettings
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
  notionMcpKey: string
  sentryMcpKey: string
  tags: string[]
}

/** Default workspace tags seeded on fresh install and on settings upgrade. */
export const DEFAULT_WORKSPACE_TAGS: string[] = [
  'bug',
  'feature',
  'refactor',
  'docs',
  'wip',
  'urgent',
  'blocked',
  'notion',
  'sentry',
]

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
  {
    version: 7,
    name: 'add-mcp-selection-keys',
    migrate({ global }) {
      if (typeof global.notionMcpKey !== 'string') global.notionMcpKey = ''
      if (typeof global.sentryMcpKey !== 'string') global.sentryMcpKey = ''
    },
  },
  {
    version: 8,
    name: 'add-workspace-tags',
    migrate({ global }) {
      if (!Array.isArray(global.tags)) global.tags = [...DEFAULT_WORKSPACE_TAGS]
    },
  },
  {
    version: 9,
    name: 'add-notion-sentry-default-tags',
    migrate({ global }) {
      if (!Array.isArray(global.tags)) {
        global.tags = [...DEFAULT_WORKSPACE_TAGS]
        return
      }
      for (const t of ['notion', 'sentry']) {
        if (!(global.tags as string[]).includes(t)) (global.tags as string[]).push(t)
      }
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

// In Vitest runs, default to a sentinel path so any test that reaches a real
// read/write without explicitly calling `_setSettingsPath()` first fails loud
// instead of silently clobbering the user's production `~/.config/kobo/settings.json`.
// A past incident (see investigation 2026-04-17) showed a `vi.spyOn(fs, 'readFileSync')`
// in another test file indirectly triggered `readSettings()` and overwrote the
// real settings file. This guard ensures such a regression cannot recur.
const VITEST_UNINITIALIZED_PATH = '__VITEST_SETTINGS_PATH_NOT_SET__'
let settingsFilePath: string = process.env.VITEST ? VITEST_UNINITIALIZED_PATH : getSettingsPath()
let settingsBackupSequence = 0

function ensureSettingsPathInitialized(): void {
  if (settingsFilePath === VITEST_UNINITIALIZED_PATH) {
    throw new Error(
      '[settings-service] Attempted to access settings in test mode without calling `_setSettingsPath()` first. ' +
        'This means a test is exercising settings-service indirectly (e.g. via `extractSentryIssue`, `getEffectiveSettings`) ' +
        'without proper isolation. Either `vi.mock("../server/services/settings-service.js", ...)` or call `_setSettingsPath(tmpPath)` in `beforeEach`.',
    )
  }
}

/** Override the settings file path (used by tests). */
export function _setSettingsPath(p: string): void {
  settingsFilePath = p
}

function defaultSettings(): Settings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    global: {
      defaultModel: 'claude-opus-4-7',
      dangerouslySkipPermissions: true,
      prPromptTemplate: DEFAULT_PR_PROMPT_TEMPLATE,
      gitConventions: DEFAULT_GIT_CONVENTIONS,
      editorCommand: '',
      browserNotifications: true,
      audioNotifications: true,
      notionStatusProperty: '',
      notionInProgressStatus: '',
      defaultPermissionMode: 'plan',
      notionMcpKey: '',
      sentryMcpKey: '',
      tags: [...DEFAULT_WORKSPACE_TAGS],
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
    devServer: {
      startCommand: '',
      stopCommand: '',
    },
    e2e: {
      framework: '',
      skill: '',
      prompt: '',
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
  ensureSettingsPathInitialized()
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
    createSettingsBackupIfPresent()
    const defaults = defaultSettings()
    writeSettings(defaults)
    return defaults
  }
  if (!parsed || typeof parsed !== 'object') {
    createSettingsBackupIfPresent()
    const defaults = defaultSettings()
    writeSettings(defaults)
    return defaults
  }

  const originalVersion = (parsed as { schemaVersion?: number }).schemaVersion
  const migrated = runSettingsMigrations(parsed as Record<string, unknown>)

  // Restore any global fields that may have been removed by external edits.
  // Defaults act as fallback for missing keys; existing values are preserved.
  const globalDefaults = defaultSettings().global
  migrated.global = { ...globalDefaults, ...migrated.global } as GlobalSettings

  // Persist if migrations bumped the version, or if global fields were restored.
  if (migrated.schemaVersion !== originalVersion) {
    writeSettings(migrated)
  }

  return migrated
}

function createSettingsBackupIfPresent(): void {
  if (!fs.existsSync(settingsFilePath)) return

  const dir = path.dirname(settingsFilePath)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  settingsBackupSequence += 1
  const backupPath = path.join(dir, `settings.json.backup-${stamp}-${settingsBackupSequence}`)
  fs.copyFileSync(settingsFilePath, backupPath)
}

function writeSettings(settings: Settings, options?: { backup?: boolean }): void {
  ensureSettingsPathInitialized()
  const tmpPath = `${settingsFilePath}.tmp`
  const dir = path.dirname(settingsFilePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  if (options?.backup) {
    createSettingsBackupIfPresent()
  }
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2), 'utf-8')
  fs.renameSync(tmpPath, settingsFilePath)
}

/** Read and return the full settings object, creating defaults if missing. */
export function getSettings(): Settings {
  return readSettings()
}

/** Keys stripped from exports — secrets that should stay on the machine. */
const SECRET_GLOBAL_KEYS = ['notionMcpKey', 'sentryMcpKey'] as const

export interface ConfigBundle {
  bundleVersion: number
  exportedAt: string
  settings: Settings
  templates: Array<Record<string, unknown>>
}

/** Build an export bundle with settings + templates. MCP keys are stripped. */
export function exportConfigBundle(templates: Array<Record<string, unknown>>): ConfigBundle {
  const settings = readSettings()
  const sanitizedGlobal: GlobalSettings = { ...settings.global }
  for (const key of SECRET_GLOBAL_KEYS) {
    sanitizedGlobal[key] = ''
  }
  return {
    bundleVersion: 1,
    exportedAt: new Date().toISOString(),
    settings: { ...settings, global: sanitizedGlobal },
    templates,
  }
}

/** Replace the settings file with an imported bundle. MCP keys in the current settings are preserved. */
export function importConfigBundle(bundle: ConfigBundle): void {
  if (!bundle || typeof bundle !== 'object') {
    throw new Error('Invalid bundle: payload must be an object')
  }
  if (bundle.bundleVersion !== 1) {
    throw new Error('Invalid bundle: expected bundleVersion = 1')
  }
  const incoming = bundle.settings as unknown
  if (!incoming || typeof incoming !== 'object') {
    throw new Error('Invalid bundle: missing or malformed settings')
  }
  const incomingSettings = incoming as { global?: unknown; projects?: unknown }
  if (
    !incomingSettings.global ||
    typeof incomingSettings.global !== 'object' ||
    Array.isArray(incomingSettings.global)
  ) {
    throw new Error('Invalid bundle: settings.global must be an object')
  }
  if (!Array.isArray(incomingSettings.projects)) {
    throw new Error('Invalid bundle: settings.projects must be an array')
  }
  for (let i = 0; i < incomingSettings.projects.length; i++) {
    const p = incomingSettings.projects[i]
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      throw new Error(`Invalid bundle: settings.projects[${i}] must be an object`)
    }
  }
  const current = readSettings()
  // Run the incoming through the migration pipeline in case an older version is imported.
  const migrated = runSettingsMigrations(incoming as Record<string, unknown>)
  // Preserve existing MCP keys — the export stripped them and we don't want to clobber a local config.
  for (const key of SECRET_GLOBAL_KEYS) {
    migrated.global[key] = current.global[key]
  }
  writeSettings(migrated, { backup: true })
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
    notionStatusProperty: settings.global.notionStatusProperty,
    notionInProgressStatus: settings.global.notionInProgressStatus,
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
    'notionMcpKey',
    'sentryMcpKey',
    'tags',
  ]
  const filtered = pickKnownKeys<GlobalSettings>(data as Record<string, unknown>, allowedGlobalKeys)
  if (filtered.tags !== undefined) {
    filtered.tags = Array.isArray(filtered.tags)
      ? Array.from(
          new Set(
            (filtered.tags as unknown[])
              .map((t) => (typeof t === 'string' ? t.trim() : ''))
              .filter((t) => t.length > 0 && t.length <= 50),
          ),
        )
      : settings.global.tags
  }
  settings.global = { ...settings.global, ...filtered }
  writeSettings(settings, { backup: true })
  return settings.global
}

/** Create or update project-specific settings. Merges devServer and e2e fields on update. */
export function upsertProject(projectPath: string, data: Partial<Omit<ProjectSettings, 'path'>>): ProjectSettings {
  const allowedProjectKeys = [
    'displayName',
    'defaultSourceBranch',
    'defaultModel',
    'dangerouslySkipPermissions',
    'prPromptTemplate',
    'gitConventions',
    'setupScript',
    'devServer',
    'e2e',
  ]
  const allowedDevServerKeys = ['startCommand', 'stopCommand']
  const allowedE2eKeys: Array<keyof E2eSettings> = ['framework', 'skill', 'prompt']
  const filtered = pickKnownKeys<Omit<ProjectSettings, 'path'>>(data as Record<string, unknown>, allowedProjectKeys)
  if (filtered.devServer) {
    filtered.devServer = pickKnownKeys<DevServerConfig>(
      filtered.devServer as unknown as Record<string, unknown>,
      allowedDevServerKeys,
    ) as DevServerConfig
  }
  if (filtered.e2e) {
    filtered.e2e = pickKnownKeys<E2eSettings>(
      filtered.e2e as unknown as Record<string, unknown>,
      allowedE2eKeys as string[],
    ) as E2eSettings
  }

  const settings = readSettings()
  const idx = settings.projects.findIndex((p) => p.path === projectPath)

  if (idx >= 0) {
    // Update existing project — merge devServer and e2e separately to allow partial updates
    const existing = settings.projects[idx]
    const updatedDevServer = filtered.devServer ? { ...existing.devServer, ...filtered.devServer } : existing.devServer
    const existingE2e = existing.e2e ?? defaultProjectSettings(projectPath).e2e
    const updatedE2e = filtered.e2e ? { ...existingE2e, ...filtered.e2e } : existingE2e
    settings.projects[idx] = {
      ...existing,
      ...filtered,
      path: projectPath,
      devServer: updatedDevServer,
      e2e: updatedE2e,
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
    if (filtered.e2e) {
      newProject.e2e = { ...defaultProjectSettings(projectPath).e2e, ...filtered.e2e }
    }
    settings.projects.push(newProject)
  }

  writeSettings(settings, { backup: true })
  return settings.projects.find((p) => p.path === projectPath) as ProjectSettings
}

/** Remove a project from the settings file. */
export function deleteProject(projectPath: string): void {
  const settings = readSettings()
  settings.projects = settings.projects.filter((p) => p.path !== projectPath)
  writeSettings(settings, { backup: true })
}

/** List all configured projects. */
export function listProjects(): ProjectSettings[] {
  return readSettings().projects
}

export interface ActiveClaudeMcpServerSummary {
  key: string
  command: string
  args: string[]
}

/** List active MCP servers from Claude Code config (~/.claude.json). */
export function listActiveClaudeMcpServers(): ActiveClaudeMcpServerSummary[] {
  return listClaudeMcpEntries().map(({ key, entry }) => ({
    key,
    command: entry.command ?? 'npx',
    args: entry.args ?? [],
  }))
}
