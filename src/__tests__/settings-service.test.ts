import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Settings } from '../server/services/settings-service.js'
import {
  _setSettingsPath,
  deleteProject,
  exportConfigBundle,
  getEffectiveSettings,
  getGlobalSettings,
  getProjectSettings,
  getSettings,
  importConfigBundle,
  listProjects,
  runSettingsMigrations,
  SETTINGS_SCHEMA_VERSION,
  updateGlobalSettings,
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
    expect(settings.global.defaultModel).toBe('claude-opus-4-7')
    expect(typeof settings.global.prPromptTemplate).toBe('string')
    expect(settings.projects).toEqual([])
  })

  it('reads existing settings file correctly', () => {
    const existing: Settings = {
      global: { defaultModel: 'claude-sonnet-4-6', prPromptTemplate: 'my template' },
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
    expect(settings.global.defaultModel).toBe('claude-sonnet-4-6')
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
    expect(written.global.defaultModel).toBe('claude-opus-4-7')
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
    expect(settings.global.defaultModel).toBe('claude-opus-4-7')
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
    updateGlobalSettings({ defaultModel: 'test-model' })

    const global = getGlobalSettings()
    expect(global.defaultModel).toBe('test-model')
    expect(typeof global.prPromptTemplate).toBe('string')
  })
})

describe('updateGlobalSettings()', () => {
  it('patches only specified fields', () => {
    getSettings() // ensure defaults
    updateGlobalSettings({ prPromptTemplate: 'new template' })

    const global = getGlobalSettings()
    expect(global.defaultModel).toBe('claude-opus-4-7') // unchanged
    expect(global.prPromptTemplate).toBe('new template') // updated
  })

  it('patches multiple fields at once', () => {
    getSettings()
    const updated = updateGlobalSettings({
      defaultModel: 'opus',
      prPromptTemplate: 'tmpl',
      notionMcpKey: 'notion',
      sentryMcpKey: 'sentry',
    })
    expect(updated.defaultModel).toBe('opus')
    expect(updated.prPromptTemplate).toBe('tmpl')
    expect(updated.notionMcpKey).toBe('notion')
    expect(updated.sentryMcpKey).toBe('sentry')
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
    updateGlobalSettings({ defaultModel: 'global-model', prPromptTemplate: 'global-template' })
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
    updateGlobalSettings({ defaultModel: 'global-model', prPromptTemplate: 'global-template' })
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
    updateGlobalSettings({ defaultModel: 'global-model', prPromptTemplate: 'global-template' })

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
    updateGlobalSettings({ defaultModel: 'test-model' })
    upsertProject('/project', { displayName: 'Project', defaultSourceBranch: 'main' })

    // Read the raw file and verify it is valid JSON
    const raw = fs.readFileSync(settingsPath, 'utf-8')
    const parsed = JSON.parse(raw) as Settings
    expect(parsed.global.defaultModel).toBe('test-model')
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
        defaultModel: 'claude-opus-4-6',
        prPromptTemplate: 'template',
        gitConventions: 'conv',
      },
      projects: [],
    }
    const migrated = runSettingsMigrations(current as unknown as Record<string, unknown>)
    expect(migrated.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    expect(migrated.global.defaultModel).toBe('claude-opus-4-6')
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

  it('tags bundleVersion = 1 and includes the passed templates array', () => {
    const templates = [{ slug: 'hello', description: 'desc', content: 'hi', createdAt: '', updatedAt: '' }]
    const bundle = exportConfigBundle(templates as unknown as Array<Record<string, unknown>>)
    expect(bundle.bundleVersion).toBe(1)
    expect(bundle.templates).toEqual(templates)
    expect(bundle.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
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
      },
      projects: [],
    }
    importConfigBundle({ bundleVersion: 1, exportedAt: '', settings: incoming, templates: [] })
    const after = getGlobalSettings()
    expect(after.notionMcpKey).toBe('local-notion')
    expect(after.sentryMcpKey).toBe('local-sentry')
    expect(after.prPromptTemplate).toBe('imported')
    expect(after.tags).toEqual(['imported-tag'])
  })
})
