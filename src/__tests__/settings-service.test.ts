import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GlobalSettings, ProjectSettings, Settings } from '../server/services/settings-service.js'
import {
  _setSettingsPath,
  DEFAULT_BRANCH_PREFIXES,
  DEFAULT_FINALIZATION_PROMPT,
  deleteProject,
  exportConfigBundle,
  getEffectiveFinalization,
  getEffectiveSettings,
  getGlobalSettings,
  getProjectSettings,
  getSettings,
  importConfigBundle,
  listProjects,
  runSettingsMigrations,
  SETTINGS_SCHEMA_VERSION,
  sanitizeBranchPrefixes,
  updateGlobalSettings,
  updateNetworkAccessSettings,
  upsertProject,
} from '../server/services/settings-service.js'

let tmpDir: string
let settingsPath: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-settings-test-'))
  settingsPath = path.join(tmpDir, 'settings.json')
  _setSettingsPath(settingsPath)
})

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

describe('getSettings()', () => {
  it('creates default settings file when it does not exist', () => {
    expect(fs.existsSync(settingsPath)).toBe(false)
    const settings = getSettings()
    expect(fs.existsSync(settingsPath)).toBe(true)
    expect(settings.global.defaultModelByEngine['claude-code']).toBe('auto')
    expect(settings.global.defaultModelByEngine.codex).toBe('auto')
    expect(settings.global.worktreesPath).toBe('.worktrees')
    expect(typeof settings.global.prPromptTemplate).toBe('string')
    expect(settings.projects).toEqual([])
  })

  it('reads existing settings file correctly', () => {
    const existing: Settings = {
      global: {
        defaultModelByEngine: { 'claude-code': 'claude-sonnet-4-6', codex: 'auto' },
        prPromptTemplate: 'my template',
      },
      projects: [
        {
          path: '/home/user/project',
          displayName: 'My Project',
          defaultSourceBranch: 'develop',
          defaultModel: 'claude-opus-4-6',
          prPromptTemplate: '',
          devServer: { startCommand: 'make dev', stopCommand: 'make stop' },
        },
      ],
    }
    fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2), 'utf-8')

    const settings = getSettings()
    expect(settings.global.defaultModelByEngine['claude-code']).toBe('claude-sonnet-4-6')
    expect(settings.global.prPromptTemplate).toBe('my template')
    expect(settings.projects.length).toBe(1)
    expect(settings.projects[0].path).toBe('/home/user/project')
    expect(settings.projects[0].devServer.startCommand).toBe('make dev')
  })

  it('creates a backup before overwriting with defaults when JSON is invalid', () => {
    fs.writeFileSync(settingsPath, 'not valid json }{', 'utf-8')

    getSettings()

    const files = fs.readdirSync(tmpDir)
    const backups = files.filter((f) => f.startsWith('settings.json.backup-'))
    expect(backups.length).toBe(1)
    // The new settings.json should contain valid defaults
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    expect(written.global.defaultModelByEngine?.['claude-code']).toBe('auto')
  })

  it('restores missing global fields to defaults when schemaVersion is current', () => {
    // Simulates a settings file that was externally modified and is missing
    // standard fields like defaultModel and prPromptTemplate
    const corrupted = {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      global: {
        gitConventions: 'my-conventions',
        dangerouslySkipPermissions: false,
        editorCommand: 'vim',
        browserNotifications: false,
        audioNotifications: false,
        notionStatusProperty: '',
        notionInProgressStatus: '',
        defaultPermissionMode: 'plan',
        notionMcpKey: '',
        sentryMcpKey: '',
        // intentionally missing: defaultModel, prPromptTemplate
      },
      projects: [],
    }
    fs.writeFileSync(settingsPath, JSON.stringify(corrupted, null, 2), 'utf-8')

    const settings = getSettings()

    // Missing fields must be restored to their defaults
    expect(settings.global.defaultModelByEngine['claude-code']).toBe('auto')
    expect(typeof settings.global.prPromptTemplate).toBe('string')
    expect(settings.global.prPromptTemplate.length).toBeGreaterThan(0)
    // Existing custom values must be preserved
    expect(settings.global.gitConventions).toBe('my-conventions')
    expect(settings.global.dangerouslySkipPermissions).toBe(false)
    expect(settings.global.editorCommand).toBe('vim')
  })
})

describe('getGlobalSettings()', () => {
  it('returns global section only', () => {
    getSettings() // ensure file exists
    updateGlobalSettings({ defaultModelByEngine: { 'claude-code': 'test-model', codex: 'auto' } })

    const global = getGlobalSettings()
    expect(global.defaultModelByEngine['claude-code']).toBe('test-model')
    expect(typeof global.prPromptTemplate).toBe('string')
  })

  it('exposes terminalCommand defaulting to empty string', () => {
    const settings = getGlobalSettings()
    expect(settings.terminalCommand).toBe('')
  })
})

describe('updateGlobalSettings()', () => {
  it('patches only specified fields', () => {
    getSettings() // ensure defaults
    updateGlobalSettings({ prPromptTemplate: 'new template' })

    const global = getGlobalSettings()
    expect(global.defaultModelByEngine['claude-code']).toBe('auto') // unchanged
    expect(global.prPromptTemplate).toBe('new template') // updated
  })

  it('patches multiple fields at once', () => {
    getSettings()
    const updated = updateGlobalSettings({
      defaultModelByEngine: { 'claude-code': 'opus', codex: 'auto' },
      prPromptTemplate: 'tmpl',
      notionMcpKey: 'notion',
      sentryMcpKey: 'sentry',
    })
    expect(updated.defaultModelByEngine['claude-code']).toBe('opus')
    expect(updated.prPromptTemplate).toBe('tmpl')
    expect(updated.notionMcpKey).toBe('notion')
    expect(updated.sentryMcpKey).toBe('sentry')
  })

  it('persists the global worktrees path verbatim after trimming', () => {
    getSettings()
    updateGlobalSettings({ worktreesPath: '  $HOME/kobo/worktress  ' })

    const global = getGlobalSettings()
    expect(global.worktreesPath).toBe('$HOME/kobo/worktress')
  })

  it('rejects a blank worktrees path and keeps the previous value', () => {
    getSettings()
    updateGlobalSettings({ worktreesPath: '$HOME/kobo/worktrees' })

    expect(() => updateGlobalSettings({ worktreesPath: '   ' })).toThrow(/required/)
    expect(getGlobalSettings().worktreesPath).toBe('$HOME/kobo/worktrees')
  })

  it('creates the global worktrees directory when an absolute path is saved', () => {
    getSettings()
    const worktreesRoot = path.join(tmpDir, 'missing', 'worktrees')

    updateGlobalSettings({ worktreesPath: worktreesRoot })

    expect(fs.statSync(worktreesRoot).isDirectory()).toBe(true)
    expect(getGlobalSettings().worktreesPath).toBe(worktreesRoot)
  })

  it('rejects unsafe worktrees paths and keeps the previous value', () => {
    getSettings()
    updateGlobalSettings({ worktreesPath: '$HOME/kobo/worktrees' })

    expect(() => updateGlobalSettings({ worktreesPath: '../outside' })).toThrow(/parent directory traversal/)
    expect(getGlobalSettings().worktreesPath).toBe('$HOME/kobo/worktrees')
  })
})

describe('upsertProject()', () => {
  it('adds a new project', () => {
    getSettings()
    const project = upsertProject('/home/user/new-project', {
      displayName: 'New Project',
      defaultSourceBranch: 'main',
    })

    expect(project.path).toBe('/home/user/new-project')
    expect(project.displayName).toBe('New Project')
    expect(project.defaultSourceBranch).toBe('main')
    expect(project.defaultModel).toBe('')
    expect(project.prPromptTemplate).toBe('')
    expect(project.devServer.startCommand).toBe('')
    expect(project.devServer.stopCommand).toBe('')

    // Verify it's persisted
    const projects = listProjects()
    expect(projects.length).toBe(1)
    expect(projects[0].path).toBe('/home/user/new-project')
  })

  it('updates existing project (matched by path)', () => {
    getSettings()
    upsertProject('/home/user/project', {
      displayName: 'Original',
      defaultSourceBranch: 'main',
    })

    const updated = upsertProject('/home/user/project', {
      displayName: 'Updated',
      defaultModel: 'claude-opus-4-6',
    })

    expect(updated.path).toBe('/home/user/project')
    expect(updated.displayName).toBe('Updated')
    expect(updated.defaultModel).toBe('claude-opus-4-6')
    expect(updated.defaultSourceBranch).toBe('main') // preserved

    const projects = listProjects()
    expect(projects.length).toBe(1) // still one project
  })

  it('defaults taskPromptTemplate to an empty string on a new project', () => {
    getSettings()
    const project = upsertProject('/tmp/task-prompt-default', { displayName: 'P' })
    expect(project.taskPromptTemplate).toBe('')
  })

  it('round-trips taskPromptTemplate via upsertProject + getProjectSettings', () => {
    getSettings()
    upsertProject('/tmp/task-prompt', { taskPromptTemplate: 'Describe the bug, steps, expected.' })
    const got = getProjectSettings('/tmp/task-prompt')
    expect(got?.taskPromptTemplate).toBe('Describe the bug, steps, expected.')
  })

  it('round-trips e2e settings via upsertProject + getProjectSettings', () => {
    getSettings()
    upsertProject('/tmp/p1', {
      e2e: { framework: 'playwright', skill: 'pw-tester', prompt: 'use page-object' },
    })
    const got = getProjectSettings('/tmp/p1')
    expect(got?.e2e).toEqual({ framework: 'playwright', skill: 'pw-tester', prompt: 'use page-object' })
  })

  it('returns the default e2e shape when the field is absent', () => {
    getSettings()
    upsertProject('/tmp/p2', { displayName: 'No E2E' })
    const got = getProjectSettings('/tmp/p2')
    expect(got?.e2e).toEqual({ framework: '', skill: '', prompt: '' })
  })

  it('drops unknown sub-keys inside e2e', () => {
    getSettings()
    upsertProject('/tmp/p3', {
      e2e: {
        framework: 'cypress',
        skill: 'cy',
        prompt: 'go',
        // @ts-expect-error - unknown sub-key
        malicious: 'value',
      },
    })
    const got = getProjectSettings('/tmp/p3')
    expect(got?.e2e).toEqual({ framework: 'cypress', skill: 'cy', prompt: 'go' })
    expect((got?.e2e as Record<string, unknown>).malicious).toBeUndefined()
  })

  it('round-trips finalization settings via upsertProject + getProjectSettings', () => {
    getSettings()
    upsertProject('/tmp/p-finalization-1', {
      finalization: { prompt: 'Run lint, typecheck, tests.' },
    })
    const got = getProjectSettings('/tmp/p-finalization-1')
    expect(got?.finalization).toEqual({ prompt: 'Run lint, typecheck, tests.' })
  })

  it('defaults the project finalization prompt to empty (inherits global) when absent', () => {
    getSettings()
    upsertProject('/tmp/p-finalization-2', { displayName: 'no finalization' })
    const got = getProjectSettings('/tmp/p-finalization-2')
    // Empty per-project prompt = inherit the global default via the cascade.
    expect(got?.finalization?.prompt).toBe('')
  })

  it('drops unknown sub-keys inside finalization', () => {
    getSettings()
    upsertProject('/tmp/p-finalization-3', {
      finalization: {
        prompt: 'do stuff',
        // @ts-expect-error - unknown sub-key
        malicious: 'attack',
      },
    })
    const got = getProjectSettings('/tmp/p-finalization-3')
    expect(got?.finalization).toEqual({ prompt: 'do stuff' })
    expect((got?.finalization as Record<string, unknown>).malicious).toBeUndefined()
  })
})

describe('getEffectiveFinalization() — project || global cascade', () => {
  it('seeds the global finalization prompt with the default (migration v38)', () => {
    getSettings()
    expect(getGlobalSettings().finalizationPrompt).toBe(DEFAULT_FINALIZATION_PROMPT)
  })

  it('falls back to the global default when the project prompt is empty', () => {
    getSettings()
    upsertProject('/tmp/p-eff-1', { finalization: { prompt: '' } })
    expect(getEffectiveFinalization('/tmp/p-eff-1')).toEqual({ prompt: DEFAULT_FINALIZATION_PROMPT })
  })

  it('uses the per-project prompt when set (overrides global)', () => {
    getSettings()
    updateGlobalSettings({ finalizationPrompt: 'GLOBAL' })
    upsertProject('/tmp/p-eff-2', { finalization: { prompt: 'PROJECT OVERRIDE' } })
    expect(getEffectiveFinalization('/tmp/p-eff-2')).toEqual({ prompt: 'PROJECT OVERRIDE' })
  })

  it('falls back to global for an unregistered project', () => {
    getSettings()
    updateGlobalSettings({ finalizationPrompt: 'GLOBAL ONLY' })
    expect(getEffectiveFinalization('/non/existent')).toEqual({ prompt: 'GLOBAL ONLY' })
  })

  it('treats a whitespace-only project prompt as empty (inherits global)', () => {
    getSettings()
    updateGlobalSettings({ finalizationPrompt: 'GLOBAL' })
    upsertProject('/tmp/p-eff-3', { finalization: { prompt: '   ' } })
    expect(getEffectiveFinalization('/tmp/p-eff-3')).toEqual({ prompt: 'GLOBAL' })
  })
})

describe('deleteProject()', () => {
  it('removes project from array', () => {
    getSettings()
    upsertProject('/home/user/a', { displayName: 'A' })
    upsertProject('/home/user/b', { displayName: 'B' })

    expect(listProjects().length).toBe(2)

    deleteProject('/home/user/a')

    const remaining = listProjects()
    expect(remaining.length).toBe(1)
    expect(remaining[0].path).toBe('/home/user/b')
  })

  it('does not throw when deleting non-existent project', () => {
    getSettings()
    expect(() => deleteProject('/non/existent')).not.toThrow()
  })
})

describe('getProjectSettings()', () => {
  it('returns null for unknown path', () => {
    getSettings()
    const result = getProjectSettings('/unknown/path')
    expect(result).toBeNull()
  })

  it('returns project when found', () => {
    getSettings()
    upsertProject('/home/user/project', { displayName: 'Test', defaultSourceBranch: 'develop' })

    const project = getProjectSettings('/home/user/project')
    expect(project).not.toBeNull()
    expect(project?.displayName).toBe('Test')
    expect(project?.defaultSourceBranch).toBe('develop')
  })
})

describe('getEffectiveSettings()', () => {
  it('merges global and project (project overrides)', () => {
    getSettings()
    updateGlobalSettings({
      defaultModelByEngine: { 'claude-code': 'global-model', codex: 'auto' },
      prPromptTemplate: 'global-template',
    })
    upsertProject('/home/user/project', {
      defaultModel: 'project-model',
      prPromptTemplate: 'project-template',
      defaultSourceBranch: 'develop',
      devServer: { startCommand: 'make dev', stopCommand: 'make stop' },
    })

    const effective = getEffectiveSettings('/home/user/project')
    expect(effective.model).toBe('project-model')
    expect(effective.prPromptTemplate).toBe('project-template')
    expect(effective.sourceBranch).toBe('develop')
    expect(effective.devServer).toEqual({ startCommand: 'make dev', stopCommand: 'make stop' })
  })

  it('falls back to global when project field is empty string', () => {
    getSettings()
    updateGlobalSettings({
      defaultModelByEngine: { 'claude-code': 'global-model', codex: 'auto' },
      prPromptTemplate: 'global-template',
    })
    upsertProject('/home/user/project', {
      defaultModel: '',
      prPromptTemplate: '',
      defaultSourceBranch: 'main',
    })

    const effective = getEffectiveSettings('/home/user/project')
    expect(effective.model).toBe('global-model')
    expect(effective.prPromptTemplate).toBe('global-template')
    expect(effective.sourceBranch).toBe('main')
  })

  it('returns globals when no project exists', () => {
    getSettings()
    updateGlobalSettings({
      defaultModelByEngine: { 'claude-code': 'global-model', codex: 'auto' },
      prPromptTemplate: 'global-template',
    })

    const effective = getEffectiveSettings('/non/existent')
    expect(effective.model).toBe('global-model')
    expect(effective.prPromptTemplate).toBe('global-template')
    expect(effective.sourceBranch).toBe('')
    expect(effective.devServer).toBeNull()
  })
})

describe('listProjects()', () => {
  it('returns all projects', () => {
    getSettings()
    upsertProject('/a', { displayName: 'A' })
    upsertProject('/b', { displayName: 'B' })
    upsertProject('/c', { displayName: 'C' })

    const projects = listProjects()
    expect(projects.length).toBe(3)
    expect(projects.map((p) => p.path)).toEqual(['/a', '/b', '/c'])
  })

  it('returns empty array when no projects', () => {
    getSettings()
    expect(listProjects()).toEqual([])
  })
})

describe('atomic write', () => {
  it('settings file is not corrupted after write', () => {
    getSettings()
    updateGlobalSettings({ defaultModelByEngine: { 'claude-code': 'test-model', codex: 'auto' } })
    upsertProject('/project', { displayName: 'Project', defaultSourceBranch: 'main' })

    // Read the raw file and verify it is valid JSON
    const raw = fs.readFileSync(settingsPath, 'utf-8')
    const parsed = JSON.parse(raw) as Settings
    expect(parsed.global.defaultModelByEngine['claude-code']).toBe('test-model')
    expect(parsed.projects.length).toBe(1)
    expect(parsed.projects[0].path).toBe('/project')

    // Verify no temp file is left behind
    expect(fs.existsSync(`${settingsPath}.tmp`)).toBe(false)
  })
})

describe('automatic settings backups', () => {
  it('creates a backup before updateGlobalSettings writes', () => {
    getSettings()
    const before = fs.readFileSync(settingsPath, 'utf-8')

    updateGlobalSettings({ defaultModel: 'claude-sonnet-4-6' })

    const backups = fs
      .readdirSync(tmpDir)
      .filter((name) => /^settings\.json\.backup-/.test(name))
      .sort()
    expect(backups.length).toBe(1)
    const backupContent = fs.readFileSync(path.join(tmpDir, backups[0]), 'utf-8')
    expect(backupContent).toBe(before)
  })

  it('creates a backup before upsertProject writes', () => {
    getSettings()
    const before = fs.readFileSync(settingsPath, 'utf-8')

    upsertProject('/tmp/proj', { displayName: 'Proj' })

    const backups = fs
      .readdirSync(tmpDir)
      .filter((name) => /^settings\.json\.backup-/.test(name))
      .sort()
    expect(backups.length).toBe(1)
    const backupContent = fs.readFileSync(path.join(tmpDir, backups[0]), 'utf-8')
    expect(backupContent).toBe(before)
  })

  it('creates a backup before deleteProject writes', () => {
    getSettings()
    upsertProject('/tmp/a', { displayName: 'A' })
    const beforeDelete = fs.readFileSync(settingsPath, 'utf-8')

    deleteProject('/tmp/a')

    const backups = fs.readdirSync(tmpDir).filter((name) => /^settings\.json\.backup-/.test(name))
    expect(backups.length).toBeGreaterThanOrEqual(2)
    const matching = backups
      .map((name) => fs.readFileSync(path.join(tmpDir, name), 'utf-8'))
      .some((content) => content === beforeDelete)
    expect(matching).toBe(true)
  })

  it('rotates backups, keeping only the 5 most recent', () => {
    getSettings()
    // 8 updates → 8 backups created, but rotation keeps only the last 5.
    for (let i = 0; i < 8; i++) {
      updateGlobalSettings({ editorCommand: `editor-${i}` })
    }

    const backups = fs.readdirSync(tmpDir).filter((name) => /^settings\.json\.backup-/.test(name))
    expect(backups.length).toBe(5)
  })
})

describe('gitConventions', () => {
  it('includes gitConventions in GlobalSettings as a string', () => {
    const global = getGlobalSettings()
    expect(global).toHaveProperty('gitConventions')
    expect(typeof global.gitConventions).toBe('string')
  })

  it('persists gitConventions on updateGlobalSettings', () => {
    updateGlobalSettings({ gitConventions: 'my global rules' })
    const reloaded = getGlobalSettings()
    expect(reloaded.gitConventions).toBe('my global rules')
  })

  it('persists gitConventions on upsertProject', () => {
    upsertProject('/tmp/project-x', { gitConventions: 'project rules' })
    const project = getProjectSettings('/tmp/project-x')
    expect(project?.gitConventions).toBe('project rules')
  })

  it('uses project gitConventions when defined', () => {
    updateGlobalSettings({ gitConventions: 'global rules' })
    upsertProject('/tmp/project-y', { gitConventions: 'project rules' })
    const effective = getEffectiveSettings('/tmp/project-y')
    expect(effective.gitConventions).toBe('project rules')
  })

  it('falls back to global gitConventions when project is empty', () => {
    updateGlobalSettings({ gitConventions: 'global rules' })
    upsertProject('/tmp/project-z', { gitConventions: '' })
    const effective = getEffectiveSettings('/tmp/project-z')
    expect(effective.gitConventions).toBe('global rules')
  })

  it('returns global gitConventions when project not found', () => {
    updateGlobalSettings({ gitConventions: 'global rules' })
    const effective = getEffectiveSettings('/tmp/unknown-project')
    expect(effective.gitConventions).toBe('global rules')
  })

  it('rejects unknown keys via whitelist (global)', () => {
    updateGlobalSettings({ gitConventions: 'rules', foo: 'bar' } as never)
    const global = getGlobalSettings()
    expect(global.gitConventions).toBe('rules')
    expect((global as never as { foo?: string }).foo).toBeUndefined()
  })

  it('rejects unknown keys via whitelist (project)', () => {
    upsertProject('/tmp/project-w', { gitConventions: 'rules', bar: 'baz' } as never)
    const project = getProjectSettings('/tmp/project-w')
    expect(project?.gitConventions).toBe('rules')
    expect((project as never as { bar?: string }).bar).toBeUndefined()
  })

  it('persists notionMcpKey and sentryMcpKey on global settings', () => {
    updateGlobalSettings({ notionMcpKey: 'notion-prod', sentryMcpKey: 'sentry-us' })
    const global = getGlobalSettings()
    expect(global.notionMcpKey).toBe('notion-prod')
    expect(global.sentryMcpKey).toBe('sentry-us')
  })
})

describe('default prefills', () => {
  it('prefills gitConventions with a non-empty default when settings.json is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-settings-'))
    _setSettingsPath(path.join(dir, 'settings.json'))
    try {
      const global = getGlobalSettings()
      expect(global.gitConventions.length).toBeGreaterThan(0)
      expect(global.gitConventions).toContain('Conventional Commits')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prefills prPromptTemplate with a non-empty default when settings.json is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-settings-'))
    _setSettingsPath(path.join(dir, 'settings.json'))
    try {
      const global = getGlobalSettings()
      expect(global.prPromptTemplate.length).toBeGreaterThan(0)
      expect(global.prPromptTemplate).toContain('{{pr_url}}')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('runSettingsMigrations()', () => {
  it('migrates legacy (unversioned) settings to v1 and adds gitConventions', () => {
    const legacy = {
      global: { defaultModel: 'auto', prPromptTemplate: 'x' },
      projects: [{ path: '/a', displayName: 'A', defaultSourceBranch: 'main' }],
    }
    const migrated = runSettingsMigrations(legacy as unknown as Record<string, unknown>)

    expect(migrated.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    expect(migrated.global.gitConventions).toBe('')
    expect(migrated.projects[0]?.gitConventions).toBe('')
  })

  it('is a no-op when the file is already at the latest version', () => {
    const current: Settings = {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      global: {
        defaultModelByEngine: { 'claude-code': 'claude-opus-4-6', codex: 'auto' },
        prPromptTemplate: 'template',
        gitConventions: 'conv',
      },
      projects: [],
    }
    const migrated = runSettingsMigrations(current as unknown as Record<string, unknown>)
    expect(migrated.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    expect(migrated.global.defaultModelByEngine['claude-code']).toBe('claude-opus-4-6')
  })

  it('backfills missing global and projects fields on empty object', () => {
    const migrated = runSettingsMigrations({})
    expect(migrated.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    expect(migrated.global).toBeDefined()
    expect(migrated.projects).toEqual([])
  })

  it('preserves existing gitConventions string during migration', () => {
    const legacy = {
      global: { gitConventions: 'my custom rules' },
      projects: [],
    }
    const migrated = runSettingsMigrations(legacy as unknown as Record<string, unknown>)
    expect(migrated.global.gitConventions).toBe('my custom rules')
  })

  it('migration v10 seeds finalization.prompt on legacy projects', () => {
    const legacy = {
      schemaVersion: 9,
      global: {},
      projects: [
        {
          path: '/legacy',
          displayName: 'legacy',
          defaultSourceBranch: '',
          defaultModel: '',
          dangerouslySkipPermissions: true,
          prPromptTemplate: '',
          gitConventions: '',
          setupScript: '',
          devServer: { startCommand: '', stopCommand: '' },
          e2e: { framework: '', skill: '', prompt: '' },
          // intentionally no `finalization`
        },
      ],
    }
    const migrated = runSettingsMigrations(legacy as unknown as Record<string, unknown>)
    expect(migrated.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    expect(migrated.projects[0]?.finalization?.prompt).toBeTruthy()
    expect(migrated.projects[0]?.finalization?.prompt).toContain('quality checks')
  })

  it('migration v11 seeds the default global worktrees path', () => {
    const legacy = {
      schemaVersion: 10,
      global: {},
      projects: [],
    }

    const migrated = runSettingsMigrations(legacy as unknown as Record<string, unknown>)
    expect(migrated.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    expect(migrated.global.worktreesPath).toBe('.worktrees')
  })

  it('migration v26 seeds the default branch prefixes on a legacy db', () => {
    const legacy = {
      schemaVersion: 25,
      global: {},
      projects: [],
    }

    const migrated = runSettingsMigrations(legacy as unknown as Record<string, unknown>)
    expect(migrated.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    expect(migrated.global.branchPrefixes).toEqual(DEFAULT_BRANCH_PREFIXES)
  })

  it('migration v26 preserves an existing branchPrefixes array', () => {
    const legacy = {
      schemaVersion: 25,
      global: { branchPrefixes: ['feat', 'bug'] },
      projects: [],
    }

    const migrated = runSettingsMigrations(legacy as unknown as Record<string, unknown>)
    expect(migrated.global.branchPrefixes).toEqual(['feat', 'bug'])
  })

  it('migration v27 seeds taskPromptTemplate on legacy projects', () => {
    const legacy = {
      schemaVersion: 26,
      global: {},
      projects: [{ path: '/legacy', displayName: 'legacy' }],
    }

    const migrated = runSettingsMigrations(legacy as unknown as Record<string, unknown>)
    expect(migrated.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    expect(migrated.projects[0]?.taskPromptTemplate).toBe('')
  })

  it('migration v27 preserves an existing taskPromptTemplate', () => {
    const legacy = {
      schemaVersion: 26,
      global: {},
      projects: [{ path: '/legacy', taskPromptTemplate: 'keep me' }],
    }

    const migrated = runSettingsMigrations(legacy as unknown as Record<string, unknown>)
    expect(migrated.projects[0]?.taskPromptTemplate).toBe('keep me')
  })

  it('migration v28 seeds cleanup script settings (global + projects)', () => {
    const legacy = {
      schemaVersion: 27,
      global: {},
      projects: [{ path: '/legacy', displayName: 'legacy' }],
    }

    const migrated = runSettingsMigrations(legacy as unknown as Record<string, unknown>)
    expect(migrated.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    expect(migrated.global.cleanupScript).toBe('')
    expect(migrated.global.cleanupScriptMode).toBe('no-tasks')
    expect(migrated.projects[0]?.cleanupScript).toBe('')
    expect(migrated.projects[0]?.cleanupScriptMode).toBe('')
  })

  it('migration v28 preserves existing cleanup script values', () => {
    const legacy = {
      schemaVersion: 27,
      global: { cleanupScript: 'global-clean', cleanupScriptMode: 'idle' },
      projects: [{ path: '/legacy', cleanupScript: 'proj-clean', cleanupScriptMode: 'no-tasks' }],
    }

    const migrated = runSettingsMigrations(legacy as unknown as Record<string, unknown>)
    expect(migrated.global.cleanupScript).toBe('global-clean')
    expect(migrated.global.cleanupScriptMode).toBe('idle')
    expect(migrated.projects[0]?.cleanupScript).toBe('proj-clean')
    expect(migrated.projects[0]?.cleanupScriptMode).toBe('no-tasks')
  })

  it('migration v29 seeds the archive script (global + projects)', () => {
    const legacy = {
      schemaVersion: 28,
      global: {},
      projects: [{ path: '/legacy', displayName: 'legacy' }],
    }

    const migrated = runSettingsMigrations(legacy as unknown as Record<string, unknown>)
    expect(migrated.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    expect(migrated.global.archiveScript).toBe('')
    expect(migrated.projects[0]?.archiveScript).toBe('')
  })

  it('migration v29 preserves existing archive script values', () => {
    const legacy = {
      schemaVersion: 28,
      global: { archiveScript: 'global-archive' },
      projects: [{ path: '/legacy', archiveScript: 'proj-archive' }],
    }

    const migrated = runSettingsMigrations(legacy as unknown as Record<string, unknown>)
    expect(migrated.global.archiveScript).toBe('global-archive')
    expect(migrated.projects[0]?.archiveScript).toBe('proj-archive')
  })

  it('migration v30 seeds the global setup script', () => {
    const legacy = { schemaVersion: 29, global: {}, projects: [] }

    const migrated = runSettingsMigrations(legacy as unknown as Record<string, unknown>)
    expect(migrated.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    expect(migrated.global.setupScript).toBe('')
  })

  it('migration v30 preserves an existing global setup script', () => {
    const legacy = { schemaVersion: 29, global: { setupScript: 'global-setup' }, projects: [] }

    const migrated = runSettingsMigrations(legacy as unknown as Record<string, unknown>)
    expect(migrated.global.setupScript).toBe('global-setup')
  })

  it('migration v31 seeds cleanupScriptOnlyOnChanges = false', () => {
    const legacy = { schemaVersion: 30, global: {}, projects: [] }

    const migrated = runSettingsMigrations(legacy as unknown as Record<string, unknown>)
    expect(migrated.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    expect(migrated.global.cleanupScriptOnlyOnChanges).toBe(false)
  })

  it('migration v31 preserves an existing cleanupScriptOnlyOnChanges value', () => {
    const legacy = { schemaVersion: 30, global: { cleanupScriptOnlyOnChanges: true }, projects: [] }

    const migrated = runSettingsMigrations(legacy as unknown as Record<string, unknown>)
    expect(migrated.global.cleanupScriptOnlyOnChanges).toBe(true)
  })
})

describe('setup script settings', () => {
  it('fresh install seeds an empty global setup script', () => {
    expect(getGlobalSettings().setupScript).toBe('')
  })

  it('getEffectiveSettings falls back to the global setup script when the project leaves it empty', () => {
    getSettings()
    updateGlobalSettings({ setupScript: 'global-setup' })
    upsertProject('/tmp/setup-fallback', { displayName: 'P' })
    expect(getEffectiveSettings('/tmp/setup-fallback').setupScript).toBe('global-setup')
  })

  it('getEffectiveSettings lets the project setup script override the global one', () => {
    getSettings()
    updateGlobalSettings({ setupScript: 'global-setup' })
    upsertProject('/tmp/setup-override', { setupScript: 'proj-setup' })
    expect(getEffectiveSettings('/tmp/setup-override').setupScript).toBe('proj-setup')
  })

  it('getEffectiveSettings uses the global setup script for an unknown project path', () => {
    getSettings()
    updateGlobalSettings({ setupScript: 'global-setup' })
    expect(getEffectiveSettings('/tmp/setup-unknown').setupScript).toBe('global-setup')
  })
})

describe('archive script settings', () => {
  it('fresh install seeds an empty global archive script', () => {
    expect(getGlobalSettings().archiveScript).toBe('')
  })

  it('getEffectiveSettings falls back to the global archive script when the project leaves it empty', () => {
    getSettings()
    updateGlobalSettings({ archiveScript: 'global-archive' })
    upsertProject('/tmp/archive-fallback', { displayName: 'P' })
    expect(getEffectiveSettings('/tmp/archive-fallback').archiveScript).toBe('global-archive')
  })

  it('getEffectiveSettings lets the project archive script override the global one', () => {
    getSettings()
    updateGlobalSettings({ archiveScript: 'global-archive' })
    upsertProject('/tmp/archive-override', { archiveScript: 'proj-archive' })
    expect(getEffectiveSettings('/tmp/archive-override').archiveScript).toBe('proj-archive')
  })

  it('getEffectiveSettings uses the global archive script for an unknown project path', () => {
    getSettings()
    updateGlobalSettings({ archiveScript: 'global-archive' })
    expect(getEffectiveSettings('/tmp/archive-unknown').archiveScript).toBe('global-archive')
  })
})

describe('cleanup script settings', () => {
  it('fresh install seeds an empty global cleanup script in no-tasks mode', () => {
    const g = getGlobalSettings()
    expect(g.cleanupScript).toBe('')
    expect(g.cleanupScriptMode).toBe('no-tasks')
    expect(g.cleanupScriptOnlyOnChanges).toBe(false)
  })

  it('exposes cleanupScriptOnlyOnChanges through getEffectiveSettings', () => {
    getSettings()
    updateGlobalSettings({ cleanupScriptOnlyOnChanges: true })
    upsertProject('/tmp/clean-changes', { displayName: 'P' })
    expect(getEffectiveSettings('/tmp/clean-changes').cleanupScriptOnlyOnChanges).toBe(true)
    expect(getEffectiveSettings('/tmp/clean-unknown-changes').cleanupScriptOnlyOnChanges).toBe(true)
  })

  it('rejects an invalid global cleanupScriptMode and keeps the previous value', () => {
    getSettings()
    updateGlobalSettings({ cleanupScriptMode: 'idle' })
    updateGlobalSettings({ cleanupScriptMode: 'bogus' as never })
    expect(getGlobalSettings().cleanupScriptMode).toBe('idle')
  })

  it("accepts an empty project cleanupScriptMode ('' = inherit)", () => {
    getSettings()
    const p = upsertProject('/tmp/clean-inherit', { cleanupScriptMode: '' })
    expect(p.cleanupScriptMode).toBe('')
  })

  it('rejects an invalid project cleanupScriptMode', () => {
    getSettings()
    upsertProject('/tmp/clean-bad', { cleanupScriptMode: 'no-tasks' })
    upsertProject('/tmp/clean-bad', { cleanupScriptMode: 'bogus' as never })
    expect(getProjectSettings('/tmp/clean-bad')?.cleanupScriptMode).toBe('no-tasks')
  })

  it('getEffectiveSettings falls back to the global cleanup script when the project leaves it empty', () => {
    getSettings()
    updateGlobalSettings({ cleanupScript: 'global-clean', cleanupScriptMode: 'idle' })
    upsertProject('/tmp/clean-fallback', { displayName: 'P' })
    const eff = getEffectiveSettings('/tmp/clean-fallback')
    expect(eff.cleanupScript).toBe('global-clean')
    expect(eff.cleanupScriptMode).toBe('idle')
  })

  it('getEffectiveSettings lets project cleanup values override the global ones', () => {
    getSettings()
    updateGlobalSettings({ cleanupScript: 'global-clean', cleanupScriptMode: 'idle' })
    upsertProject('/tmp/clean-override', { cleanupScript: 'proj-clean', cleanupScriptMode: 'no-tasks' })
    const eff = getEffectiveSettings('/tmp/clean-override')
    expect(eff.cleanupScript).toBe('proj-clean')
    expect(eff.cleanupScriptMode).toBe('no-tasks')
  })

  it('getEffectiveSettings uses global cleanup settings for an unknown project path', () => {
    getSettings()
    updateGlobalSettings({ cleanupScript: 'global-clean', cleanupScriptMode: 'idle' })
    const eff = getEffectiveSettings('/tmp/clean-unknown')
    expect(eff.cleanupScript).toBe('global-clean')
    expect(eff.cleanupScriptMode).toBe('idle')
  })
})

describe('sanitizeBranchPrefixes()', () => {
  it('trims, strips surrounding slashes and dedupes', () => {
    expect(sanitizeBranchPrefixes(['  feature/ ', '/fix/', 'feature'])).toEqual(['feature', 'fix'])
  })

  it('drops empty, oversized and invalid entries', () => {
    expect(sanitizeBranchPrefixes(['', '   ', 'a'.repeat(51), 'has space', 'bad~char', 'up..down', 'ok'])).toEqual([
      'ok',
    ])
  })

  it('returns an empty array for non-array input', () => {
    expect(sanitizeBranchPrefixes('feature')).toEqual([])
    expect(sanitizeBranchPrefixes(undefined)).toEqual([])
  })
})

describe('updateGlobalSettings() — branchPrefixes', () => {
  it('fresh install seeds the default branch prefixes', () => {
    expect(getGlobalSettings().branchPrefixes).toEqual(DEFAULT_BRANCH_PREFIXES)
  })

  it('sanitizes the saved list (trim, strip slashes, dedupe)', () => {
    getSettings()
    const updated = updateGlobalSettings({ branchPrefixes: [' feature/ ', 'fix', 'fix', '/chore/'] })
    expect(updated.branchPrefixes).toEqual(['feature', 'fix', 'chore'])
  })

  it('keeps the previous list when the new one sanitizes to empty', () => {
    getSettings()
    updateGlobalSettings({ branchPrefixes: ['feature', 'fix'] })
    const updated = updateGlobalSettings({ branchPrefixes: ['', '   ', 'bad char'] })
    expect(updated.branchPrefixes).toEqual(['feature', 'fix'])
  })
})

describe('settings file persistence with migrations', () => {
  it('writes schemaVersion in a fresh settings.json', () => {
    getSettings() // triggers defaultSettings()
    const content = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    expect(content.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
  })

  it('upgrades and persists a pre-versioned settings.json on load', () => {
    const legacy = {
      global: { defaultModel: 'auto', prPromptTemplate: 'old' },
      projects: [{ path: '/a', displayName: 'A', defaultSourceBranch: 'main' }],
    }
    fs.writeFileSync(settingsPath, JSON.stringify(legacy))
    const loaded = getSettings()

    expect(loaded.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    expect(loaded.global.gitConventions).toBe('')

    // Verify it was persisted to disk (not just in-memory)
    const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    expect(onDisk.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    expect(onDisk.global.gitConventions).toBe('')
  })

  it('does not re-write the file when already at the latest version', () => {
    getSettings() // creates file
    const mtimeBefore = fs.statSync(settingsPath).mtimeMs
    // Wait a tiny bit then re-read
    const loaded = getSettings()
    expect(loaded.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    const mtimeAfter = fs.statSync(settingsPath).mtimeMs
    expect(mtimeAfter).toBe(mtimeBefore)
  })
})

describe('exportConfigBundle()', () => {
  it('strips MCP secrets (notionMcpKey, sentryMcpKey) from exported settings', () => {
    updateGlobalSettings({ notionMcpKey: 'secret-notion', sentryMcpKey: 'secret-sentry' })
    const bundle = exportConfigBundle([])
    expect(bundle.settings.global.notionMcpKey).toBe('')
    expect(bundle.settings.global.sentryMcpKey).toBe('')
  })

  it('strips networkAccessToken from exported settings', () => {
    // networkAccessToken is not in the update allowlist — write directly to simulate a stored token
    const settings = getSettings()
    settings.global.networkAccessToken = 'secret-lan-token'
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')
    const bundle = exportConfigBundle([])
    expect(bundle.settings.global.networkAccessToken).toBe('')
  })

  it('tags bundleVersion = 1 and includes the passed templates array', () => {
    const templates = [{ slug: 'hello', description: 'desc', content: 'hi', createdAt: '', updatedAt: '' }]
    const bundle = exportConfigBundle(templates as unknown as Array<Record<string, unknown>>)
    expect(bundle.bundleVersion).toBe(1)
    expect(bundle.templates).toEqual(templates)
    expect(bundle.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('includes per-engine maps (defaultModelByEngine, defaultPermissionModeByEngine) in the export', () => {
    updateGlobalSettings({
      defaultModelByEngine: { 'claude-code': 'claude-opus-4-7', codex: 'gpt-5-codex' },
      defaultPermissionModeByEngine: { 'claude-code': 'plan', codex: 'interactive' },
    })
    const bundle = exportConfigBundle([])
    expect(bundle.settings.global.defaultModelByEngine).toEqual({
      'claude-code': 'claude-opus-4-7',
      codex: 'gpt-5-codex',
    })
    expect(bundle.settings.global.defaultPermissionModeByEngine).toEqual({
      'claude-code': 'plan',
      codex: 'interactive',
    })
  })
})

describe('importConfigBundle()', () => {
  it('rejects a bundle without bundleVersion = 1', () => {
    expect(() => importConfigBundle({ bundleVersion: 2 } as unknown as never)).toThrow('Invalid bundle')
  })

  it('rejects a non-object payload', () => {
    expect(() => importConfigBundle(null as unknown as never)).toThrow('Invalid bundle')
  })

  it('rejects a bundle with missing settings', () => {
    expect(() => importConfigBundle({ bundleVersion: 1 } as unknown as never)).toThrow('Invalid bundle')
  })

  it('rejects a bundle when settings.global is not an object', () => {
    const bundle = { bundleVersion: 1, settings: { global: [], projects: [] } } as unknown
    expect(() => importConfigBundle(bundle as never)).toThrow('settings.global')
  })

  it('rejects a bundle when settings.projects is not an array', () => {
    const bundle = { bundleVersion: 1, settings: { global: {}, projects: 'not-an-array' } } as unknown
    expect(() => importConfigBundle(bundle as never)).toThrow('settings.projects')
  })

  it('rejects a bundle with a non-object project entry', () => {
    const bundle = { bundleVersion: 1, settings: { global: {}, projects: ['hello'] } } as unknown
    expect(() => importConfigBundle(bundle as never)).toThrow('settings.projects[0]')
  })

  it('migrates a legacy bundle (schemaVersion < 19) to the per-engine maps on import', () => {
    const legacyBundle = {
      bundleVersion: 1,
      exportedAt: '',
      settings: {
        schemaVersion: 18,
        global: {
          defaultModel: 'claude-opus-4-7',
          defaultPermissionMode: 'strict',
          dangerouslySkipPermissions: false,
          prPromptTemplate: '',
          gitConventions: '',
          editorCommand: '',
          browserNotifications: false,
          audioNotifications: false,
          notionStatusProperty: '',
          notionInProgressStatus: '',
          notionMcpKey: '',
          sentryMcpKey: '',
          tags: [],
          worktreesPath: '$HOME/kobo/worktrees',
        },
        projects: [],
      },
      templates: [],
    }
    importConfigBundle(legacyBundle as never)
    const after = getGlobalSettings()
    // v19 migration: defaultModel → defaultModelByEngine (mirrored for both engines)
    expect(after.defaultModelByEngine?.['claude-code']).toBe('claude-opus-4-7')
    expect(after.defaultModelByEngine?.codex).toBeDefined()
    // v20 migration: defaultPermissionMode → defaultPermissionModeByEngine
    expect(after.defaultPermissionModeByEngine?.['claude-code']).toBe('strict')
    expect(after.defaultPermissionModeByEngine?.codex).toBe('strict')
    expect((after as unknown as { defaultModel?: string }).defaultModel).toBeUndefined()
    expect((after as unknown as { defaultPermissionMode?: string }).defaultPermissionMode).toBeUndefined()
  })

  it('preserves local MCP keys when importing', () => {
    // Set local MCP keys
    updateGlobalSettings({ notionMcpKey: 'local-notion', sentryMcpKey: 'local-sentry' })
    const incoming: Settings = {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      global: {
        defaultModel: 'claude-opus-4-7',
        dangerouslySkipPermissions: true,
        prPromptTemplate: 'imported',
        gitConventions: 'imported',
        editorCommand: '',
        browserNotifications: true,
        audioNotifications: true,
        notionStatusProperty: '',
        notionInProgressStatus: '',
        defaultPermissionMode: 'plan',
        notionMcpKey: '', // stripped on export
        sentryMcpKey: '', // stripped on export
        tags: ['imported-tag'],
        worktreesPath: '$HOME/kobo/worktress',
      },
      projects: [],
    }
    importConfigBundle({ bundleVersion: 1, exportedAt: '', settings: incoming, templates: [] })
    const after = getGlobalSettings()
    expect(after.notionMcpKey).toBe('local-notion')
    expect(after.sentryMcpKey).toBe('local-sentry')
    expect(after.prPromptTemplate).toBe('imported')
    expect(after.tags).toEqual(['imported-tag'])
    expect(after.worktreesPath).toBe('$HOME/kobo/worktress')
  })

  it('preserves local networkAccessToken when importing', () => {
    // networkAccessToken is not in the update allowlist — write directly to simulate a stored token
    const localSettings = getSettings()
    localSettings.global.networkAccessToken = 'local-lan-token'
    fs.writeFileSync(settingsPath, JSON.stringify(localSettings, null, 2), 'utf-8')
    const incoming: Settings = {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      global: {
        defaultModel: 'claude-opus-4-7',
        dangerouslySkipPermissions: false,
        prPromptTemplate: 'imported',
        gitConventions: '',
        editorCommand: '',
        browserNotifications: false,
        audioNotifications: false,
        notionStatusProperty: '',
        notionInProgressStatus: '',
        defaultPermissionMode: 'plan',
        notionMcpKey: '',
        sentryMcpKey: '',
        networkAccessToken: '', // stripped on export
        tags: [],
        worktreesPath: '$HOME/kobo/worktrees',
      },
      projects: [],
    }
    importConfigBundle({ bundleVersion: 1, exportedAt: '', settings: incoming, templates: [] })
    const after = getGlobalSettings()
    expect(after.networkAccessToken).toBe('local-lan-token')
    expect(after.prPromptTemplate).toBe('imported')
  })
})

describe('worktreesPrefixByProject migration', () => {
  it('seeds false on a fresh install via defaultSettings', () => {
    // settingsPath points to a non-existent file in a fresh tmpDir (via beforeEach).
    // getSettings() creates defaults → worktreesPrefixByProject must be present.
    const settings = getGlobalSettings()
    expect(settings.worktreesPrefixByProject).toBe(false)
  })

  it('migration 14 fills missing field on upgraded installs', () => {
    // Simulate a v13 settings file that is missing the new field.
    const v13Settings = {
      schemaVersion: 13,
      global: {
        defaultModel: 'claude-opus-4-7',
        dangerouslySkipPermissions: true,
        prPromptTemplate: '',
        gitConventions: '',
        editorCommand: '',
        browserNotifications: true,
        audioNotifications: true,
        audioNotificationSound: 'hey.mp3',
        audioNotificationVolume: 1,
        notionStatusProperty: '',
        notionInProgressStatus: '',
        defaultPermissionMode: 'plan',
        notionMcpKey: '',
        sentryMcpKey: '',
        tags: [],
        worktreesPath: '.worktrees',
        // intentionally missing: worktreesPrefixByProject
      },
      projects: [],
    }
    fs.writeFileSync(settingsPath, JSON.stringify(v13Settings, null, 2), 'utf-8')
    // getSettings() triggers migrations on read
    const settings = getGlobalSettings()
    expect(settings.worktreesPrefixByProject).toBe(false)
  })

  it('preserves an explicit false on upgrade — explicit choice is sticky', () => {
    // A user who deliberately turned the toggle off must not have it flipped
    // back on by a migration re-run. The guard `typeof === 'boolean'` keeps
    // the existing value untouched.
    const v13Settings = {
      schemaVersion: 13,
      global: {
        defaultModel: 'claude-opus-4-7',
        dangerouslySkipPermissions: true,
        prPromptTemplate: '',
        gitConventions: '',
        editorCommand: '',
        browserNotifications: true,
        audioNotifications: true,
        audioNotificationSound: 'hey.mp3',
        audioNotificationVolume: 1,
        notionStatusProperty: '',
        notionInProgressStatus: '',
        defaultPermissionMode: 'plan',
        notionMcpKey: '',
        sentryMcpKey: '',
        tags: [],
        worktreesPath: '.worktrees',
        worktreesPrefixByProject: false,
      },
      projects: [],
    }
    fs.writeFileSync(settingsPath, JSON.stringify(v13Settings, null, 2), 'utf-8')
    const settings = getGlobalSettings()
    expect(settings.worktreesPrefixByProject).toBe(false)
  })
})

describe('reviewPromptTemplate (migration v15)', () => {
  it('seeds a non-empty default on a fresh install via defaultSettings', () => {
    const global = getGlobalSettings()
    expect(typeof global.reviewPromptTemplate).toBe('string')
    expect(global.reviewPromptTemplate.length).toBeGreaterThan(0)
  })

  it('migration v15 fills missing global field on upgraded installs', () => {
    const v14Settings = {
      schemaVersion: 14,
      global: {
        defaultModel: 'claude-opus-4-7',
        dangerouslySkipPermissions: true,
        prPromptTemplate: '',
        gitConventions: '',
        editorCommand: '',
        browserNotifications: true,
        audioNotifications: true,
        audioNotificationSound: 'hey.mp3',
        audioNotificationVolume: 1,
        notionStatusProperty: '',
        notionInProgressStatus: '',
        defaultPermissionMode: 'plan',
        notionMcpKey: '',
        sentryMcpKey: '',
        tags: [],
        worktreesPath: '.worktrees',
        worktreesPrefixByProject: true,
        // intentionally missing: reviewPromptTemplate
      },
      projects: [],
    }
    fs.writeFileSync(settingsPath, JSON.stringify(v14Settings, null, 2), 'utf-8')
    const settings = getGlobalSettings()
    expect(typeof settings.reviewPromptTemplate).toBe('string')
    expect(settings.reviewPromptTemplate.length).toBeGreaterThan(0)
  })

  it('migration v15 backfills reviewPromptTemplate as empty string on existing projects', () => {
    const v14Settings = {
      schemaVersion: 14,
      global: {
        defaultModel: 'claude-opus-4-7',
        dangerouslySkipPermissions: true,
        prPromptTemplate: '',
        gitConventions: '',
        editorCommand: '',
        browserNotifications: true,
        audioNotifications: true,
        audioNotificationSound: 'hey.mp3',
        audioNotificationVolume: 1,
        notionStatusProperty: '',
        notionInProgressStatus: '',
        defaultPermissionMode: 'plan',
        notionMcpKey: '',
        sentryMcpKey: '',
        tags: [],
        worktreesPath: '.worktrees',
        worktreesPrefixByProject: true,
      },
      projects: [
        {
          path: '/legacy-project',
          displayName: 'legacy',
          defaultSourceBranch: '',
          defaultModel: '',
          dangerouslySkipPermissions: true,
          prPromptTemplate: '',
          gitConventions: '',
          setupScript: '',
          devServer: { startCommand: '', stopCommand: '' },
          e2e: { framework: '', skill: '', prompt: '' },
          finalization: { prompt: 'do quality checks' },
          // intentionally missing: reviewPromptTemplate
        },
      ],
    }
    fs.writeFileSync(settingsPath, JSON.stringify(v14Settings, null, 2), 'utf-8')
    getGlobalSettings() // triggers migration
    const project = getProjectSettings('/legacy-project')
    expect(project?.reviewPromptTemplate).toBe('')
  })

  it('schemaVersion bumps to 15 (or higher) after running migrations on legacy data', () => {
    const v14Settings = {
      schemaVersion: 14,
      global: {},
      projects: [],
    }
    const migrated = runSettingsMigrations(v14Settings as unknown as Record<string, unknown>)
    expect(migrated.schemaVersion).toBeGreaterThanOrEqual(15)
    expect(migrated.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
  })

  it('preserves an existing custom global reviewPromptTemplate on re-migration', () => {
    const customSettings = {
      schemaVersion: 14,
      global: {
        reviewPromptTemplate: 'my custom review template',
      },
      projects: [],
    }
    const migrated = runSettingsMigrations(customSettings as unknown as Record<string, unknown>)
    expect(migrated.global.reviewPromptTemplate).toBe('my custom review template')
  })

  it('getEffectiveSettings returns the project reviewPromptTemplate when non-empty', () => {
    getSettings()
    upsertProject('/tmp/proj-review-1', {
      reviewPromptTemplate: 'project-review-template',
    })
    const effective = getEffectiveSettings('/tmp/proj-review-1')
    expect(effective.reviewPromptTemplate).toBe('project-review-template')
  })

  it('getEffectiveSettings falls back to global reviewPromptTemplate when project field is empty', () => {
    getSettings()
    updateGlobalSettings({ reviewPromptTemplate: 'global-review-template' })
    upsertProject('/tmp/proj-review-2', { reviewPromptTemplate: '' })
    const effective = getEffectiveSettings('/tmp/proj-review-2')
    expect(effective.reviewPromptTemplate).toBe('global-review-template')
  })

  it('getEffectiveSettings returns global reviewPromptTemplate when no project exists', () => {
    getSettings()
    updateGlobalSettings({ reviewPromptTemplate: 'global-only' })
    const effective = getEffectiveSettings('/non/existent/proj-review')
    expect(effective.reviewPromptTemplate).toBe('global-only')
  })

  it('persists reviewPromptTemplate via updateGlobalSettings', () => {
    getSettings()
    updateGlobalSettings({ reviewPromptTemplate: 'updated' })
    const reloaded = getGlobalSettings()
    expect(reloaded.reviewPromptTemplate).toBe('updated')
  })

  it('persists reviewPromptTemplate via upsertProject', () => {
    getSettings()
    upsertProject('/tmp/proj-review-3', { reviewPromptTemplate: 'project rules' })
    const project = getProjectSettings('/tmp/proj-review-3')
    expect(project?.reviewPromptTemplate).toBe('project rules')
  })
})

describe('initial-prompt defaults', () => {
  it('global defaults expose notionInitialPromptTemplate and sentryInitialPromptTemplate non-empty', () => {
    const g = getGlobalSettings()
    expect(typeof g.notionInitialPromptTemplate).toBe('string')
    expect(g.notionInitialPromptTemplate.length).toBeGreaterThan(0)
    expect(typeof g.sentryInitialPromptTemplate).toBe('string')
    expect(g.sentryInitialPromptTemplate.length).toBeGreaterThan(0)
  })

  it('project defaults expose both keys as empty strings', () => {
    getSettings()
    upsertProject('/some/path', {})
    const p = getProjectSettings('/some/path')
    expect(p?.notionInitialPromptTemplate).toBe('')
    expect(p?.sentryInitialPromptTemplate).toBe('')
  })
})

describe('settings migration v16 — add Notion/Sentry initial prompts', () => {
  it('seeds the two global defaults when missing on a v15 settings file', () => {
    const v15Settings = {
      schemaVersion: 15,
      global: {
        defaultModel: 'claude-opus-4-7',
        dangerouslySkipPermissions: true,
        prPromptTemplate: '',
        reviewPromptTemplate: 'existing review template',
        gitConventions: '',
        editorCommand: '',
        browserNotifications: true,
        audioNotifications: true,
        audioNotificationSound: 'hey.mp3',
        audioNotificationVolume: 1,
        notionStatusProperty: '',
        notionInProgressStatus: '',
        defaultPermissionMode: 'plan',
        notionMcpKey: '',
        sentryMcpKey: '',
        tags: [],
        worktreesPath: '.worktrees',
        worktreesPrefixByProject: true,
        // intentionally missing: notionInitialPromptTemplate, sentryInitialPromptTemplate
      },
      projects: [
        {
          path: '/p',
          displayName: '',
          defaultSourceBranch: '',
          defaultModel: '',
          dangerouslySkipPermissions: true,
          prPromptTemplate: '',
          reviewPromptTemplate: '',
          gitConventions: '',
          setupScript: '',
          devServer: { startCommand: '', stopCommand: '' },
          e2e: { framework: '', skill: '', prompt: '' },
          finalization: { prompt: '' },
        },
      ],
    }
    fs.writeFileSync(settingsPath, JSON.stringify(v15Settings, null, 2), 'utf-8')
    const loaded = getGlobalSettings()
    expect(typeof loaded.notionInitialPromptTemplate).toBe('string')
    expect(loaded.notionInitialPromptTemplate.length).toBeGreaterThan(0)
    expect(typeof loaded.sentryInitialPromptTemplate).toBe('string')
    expect(loaded.sentryInitialPromptTemplate.length).toBeGreaterThan(0)
  })

  it('seeds an empty string on each project entry when the field is missing', () => {
    const v15Settings = {
      schemaVersion: 15,
      global: {
        defaultModel: 'claude-opus-4-7',
        dangerouslySkipPermissions: true,
        prPromptTemplate: '',
        reviewPromptTemplate: '',
        gitConventions: '',
        editorCommand: '',
        browserNotifications: true,
        audioNotifications: true,
        audioNotificationSound: 'hey.mp3',
        audioNotificationVolume: 1,
        notionStatusProperty: '',
        notionInProgressStatus: '',
        defaultPermissionMode: 'plan',
        notionMcpKey: '',
        sentryMcpKey: '',
        tags: [],
        worktreesPath: '.worktrees',
        worktreesPrefixByProject: true,
      },
      projects: [
        {
          path: '/p',
          displayName: '',
          defaultSourceBranch: '',
          defaultModel: '',
          dangerouslySkipPermissions: true,
          prPromptTemplate: '',
          reviewPromptTemplate: '',
          gitConventions: '',
          setupScript: '',
          devServer: { startCommand: '', stopCommand: '' },
          e2e: { framework: '', skill: '', prompt: '' },
          finalization: { prompt: '' },
          // intentionally missing: notionInitialPromptTemplate, sentryInitialPromptTemplate
        },
      ],
    }
    fs.writeFileSync(settingsPath, JSON.stringify(v15Settings, null, 2), 'utf-8')
    getGlobalSettings() // triggers migration
    const proj = getProjectSettings('/p')
    expect(proj?.notionInitialPromptTemplate).toBe('')
    expect(proj?.sentryInitialPromptTemplate).toBe('')
  })

  it('does not overwrite an already-set value on either field', () => {
    const v15Settings = {
      schemaVersion: 15,
      global: {
        defaultModel: 'claude-opus-4-7',
        dangerouslySkipPermissions: true,
        prPromptTemplate: '',
        reviewPromptTemplate: '',
        notionInitialPromptTemplate: 'CUSTOM',
        sentryInitialPromptTemplate: 'CUSTOM-SENTRY',
        gitConventions: '',
        editorCommand: '',
        browserNotifications: true,
        audioNotifications: true,
        audioNotificationSound: 'hey.mp3',
        audioNotificationVolume: 1,
        notionStatusProperty: '',
        notionInProgressStatus: '',
        defaultPermissionMode: 'plan',
        notionMcpKey: '',
        sentryMcpKey: '',
        tags: [],
        worktreesPath: '.worktrees',
        worktreesPrefixByProject: true,
      },
      projects: [
        {
          path: '/p',
          displayName: '',
          defaultSourceBranch: '',
          defaultModel: '',
          dangerouslySkipPermissions: true,
          prPromptTemplate: '',
          reviewPromptTemplate: '',
          notionInitialPromptTemplate: 'CUSTOM-PROJ-NOTION',
          sentryInitialPromptTemplate: 'CUSTOM-PROJ',
          gitConventions: '',
          setupScript: '',
          devServer: { startCommand: '', stopCommand: '' },
          e2e: { framework: '', skill: '', prompt: '' },
          finalization: { prompt: '' },
        },
      ],
    }
    fs.writeFileSync(settingsPath, JSON.stringify(v15Settings, null, 2), 'utf-8')
    const g = getGlobalSettings()
    expect(g.notionInitialPromptTemplate).toBe('CUSTOM')
    expect(g.sentryInitialPromptTemplate).toBe('CUSTOM-SENTRY')
    const p = getProjectSettings('/p')
    expect(p?.notionInitialPromptTemplate).toBe('CUSTOM-PROJ-NOTION')
    expect(p?.sentryInitialPromptTemplate).toBe('CUSTOM-PROJ')
  })
})

describe('settings migration v19 — split defaultModel by engine', () => {
  it('migrates legacy defaultModel to defaultModelByEngine.claude-code', () => {
    const legacy = {
      schemaVersion: 18,
      global: {
        defaultModel: 'claude-sonnet-4-6',
        dangerouslySkipPermissions: true,
        prPromptTemplate: '',
        reviewPromptTemplate: '',
        gitConventions: '',
        editorCommand: '',
        browserNotifications: true,
        audioNotifications: true,
        audioNotificationSound: 'hey.mp3',
        audioNotificationVolume: 1,
        notionStatusProperty: '',
        notionInProgressStatus: '',
        defaultPermissionMode: 'plan',
        notionMcpKey: '',
        sentryMcpKey: '',
        tags: [],
        worktreesPath: '.worktrees',
        worktreesPrefixByProject: false,
        voiceEnabled: false,
        voicePttKey: 'alt',
        voiceLanguage: 'auto',
        voiceModel: null,
        voiceCommandPath: '',
        voiceFfmpegPath: '',
        voiceTemperature: 0,
        voicePrompt: '',
        voiceTranslateToEnglish: false,
        voiceSuppressNonSpeechTokens: true,
      },
      projects: [],
    }
    fs.writeFileSync(settingsPath, JSON.stringify(legacy), 'utf-8')
    const settings = getSettings()
    expect(settings.global.defaultModelByEngine).toEqual({
      'claude-code': 'claude-sonnet-4-6',
      codex: 'auto',
    })
    // Legacy field must be deleted
    expect((settings.global as unknown as { defaultModel?: string }).defaultModel).toBeUndefined()
  })

  it('seeds defaults to auto when legacy field is empty', () => {
    const legacy = { schemaVersion: 18, global: { defaultModel: '' }, projects: [] }
    fs.writeFileSync(settingsPath, JSON.stringify(legacy), 'utf-8')
    const settings = getSettings()
    expect(settings.global.defaultModelByEngine['claude-code']).toBe('auto')
    expect(settings.global.defaultModelByEngine.codex).toBe('auto')
  })

  it('preserves an existing defaultModelByEngine and backfills missing keys', () => {
    const existing = {
      schemaVersion: 18,
      global: { defaultModelByEngine: { 'claude-code': 'claude-opus-4-7' } },
      projects: [],
    }
    fs.writeFileSync(settingsPath, JSON.stringify(existing), 'utf-8')
    const settings = getSettings()
    expect(settings.global.defaultModelByEngine['claude-code']).toBe('claude-opus-4-7')
    expect(settings.global.defaultModelByEngine.codex).toBe('auto')
  })
})

describe('settings migration v20 — split defaultPermissionMode by engine', () => {
  it('migrates legacy defaultPermissionMode to defaultPermissionModeByEngine.claude-code', () => {
    const legacy = { schemaVersion: 19, global: { defaultPermissionMode: 'strict' }, projects: [] }
    fs.writeFileSync(settingsPath, JSON.stringify(legacy), 'utf-8')
    const settings = getSettings()
    expect(settings.global.defaultPermissionModeByEngine).toEqual({
      'claude-code': 'strict',
      codex: 'strict',
    })
    // Legacy field must be deleted
    expect((settings.global as unknown as { defaultPermissionMode?: string }).defaultPermissionMode).toBeUndefined()
  })

  it('preserves interactive verbatim for both engines', () => {
    const legacy = { schemaVersion: 19, global: { defaultPermissionMode: 'interactive' }, projects: [] }
    fs.writeFileSync(settingsPath, JSON.stringify(legacy), 'utf-8')
    const settings = getSettings()
    expect(settings.global.defaultPermissionModeByEngine['claude-code']).toBe('interactive')
    expect(settings.global.defaultPermissionModeByEngine.codex).toBe('interactive')
  })

  it('defaults to plan when legacy field is missing', () => {
    const legacy = { schemaVersion: 19, global: {}, projects: [] }
    fs.writeFileSync(settingsPath, JSON.stringify(legacy), 'utf-8')
    const settings = getSettings()
    expect(settings.global.defaultPermissionModeByEngine['claude-code']).toBe('plan')
    expect(settings.global.defaultPermissionModeByEngine.codex).toBe('plan')
  })

  it('preserves an existing defaultPermissionModeByEngine and backfills missing keys', () => {
    const existing = {
      schemaVersion: 19,
      global: { defaultPermissionModeByEngine: { 'claude-code': 'bypass' } },
      projects: [],
    }
    fs.writeFileSync(settingsPath, JSON.stringify(existing), 'utf-8')
    const settings = getSettings()
    expect(settings.global.defaultPermissionModeByEngine['claude-code']).toBe('bypass')
    // Backfilled from legacy 'plan' since the user didn't set codex explicitly.
    expect(settings.global.defaultPermissionModeByEngine.codex).toBe('plan')
  })

  it('leaves an explicit codex=interactive in place', () => {
    const existing = {
      schemaVersion: 19,
      global: {
        defaultPermissionModeByEngine: { 'claude-code': 'interactive', codex: 'interactive' },
      },
      projects: [],
    }
    fs.writeFileSync(settingsPath, JSON.stringify(existing), 'utf-8')
    const settings = getSettings()
    expect(settings.global.defaultPermissionModeByEngine['claude-code']).toBe('interactive')
    expect(settings.global.defaultPermissionModeByEngine.codex).toBe('interactive')
  })
})

describe('migration v21 — add-project-color-and-flatten', () => {
  it('fresh project defaults include color=null', () => {
    getSettings()
    const proj = upsertProject('/tmp/p1', { displayName: 'P1' })
    expect(proj.color).toBeNull()
  })

  it('fresh global settings include flattenWorkspaceList=false', () => {
    const settings = getSettings()
    expect(settings.global.flattenWorkspaceList).toBe(false)
  })

  it('upsertProject accepts a valid palette colour', () => {
    getSettings()
    upsertProject('/tmp/p1', { displayName: 'P1' })
    const updated = upsertProject('/tmp/p1', { color: 'purple-5' })
    expect(updated.color).toBe('purple-5')
  })

  it('upsertProject ignores an invalid colour (keeps previous)', () => {
    getSettings()
    upsertProject('/tmp/p1', { color: 'purple-5' })
    const updated = upsertProject('/tmp/p1', { color: 'not-a-color' as never })
    expect(updated.color).toBe('purple-5')
  })

  it('upsertProject accepts null (clears the colour)', () => {
    getSettings()
    upsertProject('/tmp/p1', { color: 'purple-5' })
    const updated = upsertProject('/tmp/p1', { color: null })
    expect(updated.color).toBeNull()
  })
})

describe('migration v22 — add-skill-suite-selector', () => {
  it('fresh project defaults include skillSuite=superpowers', () => {
    const settings = getSettings()
    expect(settings.global.skillSuite).toBe('superpowers')
  })

  it('fresh project seeds the 4 custom* fields with agnostic defaults', () => {
    const settings = getSettings()
    expect(settings.global.customReviewTemplate).toContain('reviewing code changes')
    expect(settings.global.customAutoLoopReviewGate).toContain('Code review gate')
    expect(settings.global.customAutoLoopGroomingIntro).toContain('GROOMING session only')
    expect(settings.global.customQaPromptTemplate).toContain('QA pass for workspace')
  })

  it('existing users without skillSuite are auto-migrated to superpowers', () => {
    // Seed a legacy settings file (no skillSuite, no custom* fields) and confirm
    // the migration backfills them.
    const legacy = {
      schemaVersion: 21,
      global: {
        flattenWorkspaceList: false,
      },
      projects: [],
    }
    fs.writeFileSync(settingsPath, JSON.stringify(legacy, null, 2), 'utf-8')

    const settings = getSettings()
    expect(settings.global.skillSuite).toBe('superpowers')
    expect(typeof settings.global.customReviewTemplate).toBe('string')
    expect(settings.global.customReviewTemplate.length).toBeGreaterThan(0)
    expect(typeof settings.global.customAutoLoopReviewGate).toBe('string')
    expect(settings.global.customAutoLoopReviewGate.length).toBeGreaterThan(0)
    expect(typeof settings.global.customAutoLoopGroomingIntro).toBe('string')
    expect(settings.global.customAutoLoopGroomingIntro.length).toBeGreaterThan(0)
    expect(typeof settings.global.customQaPromptTemplate).toBe('string')
    expect(settings.global.customQaPromptTemplate.length).toBeGreaterThan(0)
  })

  it('updateGlobalSettings accepts skillSuite=gstack', () => {
    updateGlobalSettings({ skillSuite: 'gstack' })
    expect(getSettings().global.skillSuite).toBe('gstack')
  })

  it('updateGlobalSettings accepts skillSuite=custom', () => {
    updateGlobalSettings({ skillSuite: 'custom' })
    expect(getSettings().global.skillSuite).toBe('custom')
  })

  it('updateGlobalSettings rejects invalid skillSuite values (previous value preserved)', () => {
    updateGlobalSettings({ skillSuite: 'gstack' })
    updateGlobalSettings({ skillSuite: 'not-a-suite' as never })
    expect(getSettings().global.skillSuite).toBe('gstack')
  })

  it('updateGlobalSettings accepts the 4 custom* string fields', () => {
    updateGlobalSettings({
      customReviewTemplate: 'CR',
      customAutoLoopReviewGate: 'CG',
      customAutoLoopGroomingIntro: 'CI',
      customQaPromptTemplate: 'CQ',
    })
    const s = getSettings()
    expect(s.global.customReviewTemplate).toBe('CR')
    expect(s.global.customAutoLoopReviewGate).toBe('CG')
    expect(s.global.customAutoLoopGroomingIntro).toBe('CI')
    expect(s.global.customQaPromptTemplate).toBe('CQ')
  })
})

describe('forge project setting', () => {
  it('migration v32 backfills forge="auto" on existing projects', () => {
    const migrated = runSettingsMigrations({
      schemaVersion: 31,
      global: {},
      projects: [{ path: '/p1' }],
    })
    expect((migrated.projects[0] as { forge?: string }).forge).toBe('auto')
  })

  it('migration v32 leaves an explicit forge value untouched', () => {
    const migrated = runSettingsMigrations({
      schemaVersion: 31,
      global: {},
      projects: [{ path: '/p1', forge: 'gitlab' }],
    })
    expect((migrated.projects[0] as { forge?: string }).forge).toBe('gitlab')
  })
})

describe('changeSourceBranchScript setting', () => {
  it('migration v33 seeds global with the Kōbō default script and leaves projects empty (inherit)', () => {
    const migrated = runSettingsMigrations({
      schemaVersion: 32,
      global: {},
      projects: [{ path: '/p1' }, { path: '/p2', changeSourceBranchScript: 'echo custom' }],
    })
    // Match a stable marker rather than the full bash body.
    const seededGlobal = (migrated.global as Record<string, unknown>).changeSourceBranchScript as string
    expect(typeof seededGlobal).toBe('string')
    expect(seededGlobal.length).toBeGreaterThan(0)
    expect(seededGlobal).toContain('Kōbō default change-source-branch script')
    expect((migrated.projects[0] as Record<string, unknown>).changeSourceBranchScript).toBe('')
    expect((migrated.projects[1] as Record<string, unknown>).changeSourceBranchScript).toBe('echo custom')
  })

  it('getEffectiveSettings cascades project override over global default', () => {
    // Per-test isolated settings path (mirrors existing tests in this file)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-settings-csbs-'))
    _setSettingsPath(path.join(tmp, 'settings.json'))
    try {
      updateGlobalSettings({ changeSourceBranchScript: 'global.sh' } as Partial<GlobalSettings>)
      upsertProject('/p1', { changeSourceBranchScript: 'project.sh' } as Partial<ProjectSettings>)
      expect(getEffectiveSettings('/p1').changeSourceBranchScript).toBe('project.sh')
      // Empty project override falls back to global
      upsertProject('/p2', { changeSourceBranchScript: '' } as Partial<ProjectSettings>)
      expect(getEffectiveSettings('/p2').changeSourceBranchScript).toBe('global.sh')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('migration v34 seeds global ciFixPromptTemplate and leaves projects empty (inherit)', () => {
    const migrated = runSettingsMigrations({
      schemaVersion: 33,
      global: {},
      projects: [{ path: '/p1' }, { path: '/p2', ciFixPromptTemplate: 'custom fix prompt' }],
    })
    const seededGlobal = (migrated.global as Record<string, unknown>).ciFixPromptTemplate as string
    expect(typeof seededGlobal).toBe('string')
    expect(seededGlobal.length).toBeGreaterThan(0)
    expect(seededGlobal).toContain('{{pr_url}}')
    expect(seededGlobal).toContain('{{failed_jobs}}')
    expect((migrated.projects[0] as Record<string, unknown>).ciFixPromptTemplate).toBe('')
    expect((migrated.projects[1] as Record<string, unknown>).ciFixPromptTemplate).toBe('custom fix prompt')
  })

  it('getEffectiveSettings cascades project ciFixPromptTemplate over global default', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-settings-cifix-'))
    _setSettingsPath(path.join(tmp, 'settings.json'))
    try {
      updateGlobalSettings({ ciFixPromptTemplate: 'global ci fix' } as Partial<GlobalSettings>)
      upsertProject('/p1', { ciFixPromptTemplate: 'project ci fix' } as Partial<ProjectSettings>)
      expect(getEffectiveSettings('/p1').ciFixPromptTemplate).toBe('project ci fix')
      upsertProject('/p2', { ciFixPromptTemplate: '' } as Partial<ProjectSettings>)
      expect(getEffectiveSettings('/p2').ciFixPromptTemplate).toBe('global ci fix')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('terminalCommand setting (migration v37)', () => {
  it('migration v37 seeds terminalCommand to empty string when absent', () => {
    const migrated = runSettingsMigrations({
      schemaVersion: 36,
      global: {},
      projects: [],
    })
    expect(migrated.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    expect((migrated.global as Record<string, unknown>).terminalCommand).toBe('')
  })

  it('migration v37 preserves an existing terminalCommand value', () => {
    const migrated = runSettingsMigrations({
      schemaVersion: 36,
      global: { terminalCommand: 'xterm' },
      projects: [],
    })
    expect((migrated.global as Record<string, unknown>).terminalCommand).toBe('xterm')
  })
})

describe('network access settings (v39)', () => {
  it('fresh install has network access disabled with empty token', () => {
    const global = getGlobalSettings()
    expect(global.networkAccessEnabled).toBe(false)
    expect(global.networkAccessToken).toBe('')
  })

  it('SETTINGS_SCHEMA_VERSION is at least 39', () => {
    expect(SETTINGS_SCHEMA_VERSION).toBeGreaterThanOrEqual(39)
  })

  it('upgrades a v38 settings file without losing data and adds network fields', () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        schemaVersion: 38,
        global: { terminalCommand: 'xterm', finalizationPrompt: 'keep me' },
        projects: [],
      }),
    )
    getSettings()
    const global = getGlobalSettings()
    expect(global.terminalCommand).toBe('xterm')
    expect(global.finalizationPrompt).toBe('keep me')
    expect(global.networkAccessEnabled).toBe(false)
    expect(global.networkAccessToken).toBe('')
  })
})

describe('question notification sound (v40)', () => {
  it('fresh install defaults the question sound to hey.mp3', () => {
    expect(getGlobalSettings().audioQuestionSound).toBe('hey.mp3')
  })

  it('SETTINGS_SCHEMA_VERSION is at least 40', () => {
    expect(SETTINGS_SCHEMA_VERSION).toBeGreaterThanOrEqual(40)
  })

  it('upgrades a v39 settings file without losing data and seeds the question sound', () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        schemaVersion: 39,
        global: { audioNotificationSound: 'travail_termine.mp3', networkAccessToken: 'keep-me' },
        projects: [],
      }),
    )
    getSettings()
    const global = getGlobalSettings()
    expect(global.audioNotificationSound).toBe('travail_termine.mp3') // preserved
    expect(global.networkAccessToken).toBe('keep-me') // preserved
    expect(global.audioQuestionSound).toBe('hey.mp3') // seeded
  })

  it('updateGlobalSettings can change the question sound (it is in the allowlist)', () => {
    updateGlobalSettings({ audioQuestionSound: 'faaah.mp3' })
    expect(getGlobalSettings().audioQuestionSound).toBe('faaah.mp3')
  })
})

describe('updateNetworkAccessSettings()', () => {
  it('persists the token to disk (real write path, not mocked)', () => {
    updateNetworkAccessSettings({ networkAccessEnabled: true, networkAccessToken: 'lan-secret-123' })
    // Re-read from disk to prove the write actually landed — this is the path the
    // generic updateGlobalSettings allowlist silently dropped.
    const global = getGlobalSettings()
    expect(global.networkAccessEnabled).toBe(true)
    expect(global.networkAccessToken).toBe('lan-secret-123')
  })

  it('updates only the provided fields', () => {
    updateNetworkAccessSettings({ networkAccessEnabled: true, networkAccessToken: 'first' })
    updateNetworkAccessSettings({ networkAccessToken: 'rotated' })
    const global = getGlobalSettings()
    expect(global.networkAccessEnabled).toBe(true) // unchanged
    expect(global.networkAccessToken).toBe('rotated')
  })

  it('updateGlobalSettings cannot flip networkAccessEnabled (kept out of the allowlist)', () => {
    updateGlobalSettings({ networkAccessEnabled: true } as Partial<GlobalSettings>)
    // The generic update path must ignore network-access fields so PUT /global
    // cannot bind the server wide without a token.
    expect(getGlobalSettings().networkAccessEnabled).toBe(false)
  })

  it('updateGlobalSettings cannot inject a networkAccessToken', () => {
    updateGlobalSettings({ networkAccessToken: 'injected' } as Partial<GlobalSettings>)
    expect(getGlobalSettings().networkAccessToken).toBe('')
  })
})
