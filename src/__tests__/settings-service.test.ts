import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Settings } from '../server/services/settings-service.js'
import {
  _setSettingsPath,
  deleteProject,
  getEffectiveSettings,
  getGlobalSettings,
  getProjectSettings,
  getSettings,
  listProjects,
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
    expect(settings.global.defaultModel).toBe('auto')
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
    expect(global.defaultModel).toBe('auto') // unchanged
    expect(global.prPromptTemplate).toBe('new template') // updated
  })

  it('patches multiple fields at once', () => {
    getSettings()
    const updated = updateGlobalSettings({ defaultModel: 'opus', prPromptTemplate: 'tmpl' })
    expect(updated.defaultModel).toBe('opus')
    expect(updated.prPromptTemplate).toBe('tmpl')
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
