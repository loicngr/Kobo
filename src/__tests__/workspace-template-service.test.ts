import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initSchema } from '../server/db/schema.js'
import {
  _setSettingsPath,
  exportConfigBundle,
  getGlobalSettings,
  importConfigBundle,
  updateGlobalSettings,
} from '../server/services/settings-service.js'

// Same pattern as templates-service.test.ts: point the path helper at a tmp file.
let tmpFile = ''
vi.mock('../server/utils/paths.js', async () => {
  const actual = await vi.importActual<typeof import('../server/utils/paths.js')>('../server/utils/paths.js')
  return { ...actual, getWorkspaceTemplatesPath: () => tmpFile }
})

import {
  createWorkspaceTemplate,
  deleteWorkspaceTemplate,
  listWorkspaceTemplates,
  MAX_WORKSPACE_TEMPLATES,
  presetFromWorkspace,
  sanitizePreset,
  updateWorkspaceTemplate,
} from '../server/services/workspace-template-service.js'

let tmpDir = ''

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-ws-templates-'))
  tmpFile = path.join(tmpDir, 'workspace-templates.json')
  _setSettingsPath(path.join(tmpDir, 'settings.json'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('sanitizePreset', () => {
  it('keeps known keys with the right type and drops the rest silently', () => {
    const preset = sanitizePreset({
      engine: 'codex',
      model: 'gpt',
      autoLoop: true,
      tasks: ['a', 'b'],
      acceptanceCriteria: ['c'],
      agentPermissionMode: 'plan',
      // Wrong types and unknown keys: not a reason to refuse the template.
      reasoningEffort: 42,
      autoLoopSessionMode: 'weekly',
      tasks2: ['x'],
      description: ['not', 'a', 'string'],
    })

    expect(preset).toEqual({
      engine: 'codex',
      model: 'gpt',
      autoLoop: true,
      tasks: ['a', 'b'],
      acceptanceCriteria: ['c'],
      agentPermissionMode: 'plan',
    })
  })

  it('returns an empty preset for anything that is not an object', () => {
    expect(sanitizePreset(null)).toEqual({})
    expect(sanitizePreset('nope')).toEqual({})
    expect(sanitizePreset([1, 2])).toEqual({})
  })

  it('drops non-string entries from task lists rather than the whole list', () => {
    expect(sanitizePreset({ tasks: ['ok', 3, null, ' also ok '] })).toEqual({ tasks: ['ok', ' also ok '] })
  })
})

describe('workspace templates CRUD', () => {
  it('persists only registered tags, deduplicates them, and preserves an explicit empty selection', () => {
    updateGlobalSettings({ tags: ['bug', 'api'] })
    const created = createWorkspaceTemplate({ name: 'Tagged', preset: { tags: ['bug', 'api', 'bug', 'deleted', 3] } })
    expect(created.preset).toEqual({ tags: ['bug', 'api'] })
    expect(listWorkspaceTemplates()[0].preset).toEqual({ tags: ['bug', 'api'] })
    expect(updateWorkspaceTemplate(created.id, { preset: { tags: [] } })?.preset).toEqual({ tags: [] })
  })

  it('removes deleted tags from every persisted template, without changing other fields or reviving them later', () => {
    updateGlobalSettings({ tags: ['bug', 'api'] })
    const a = createWorkspaceTemplate({ name: 'A', preset: { tags: ['bug', 'api'], model: 'm' } })
    createWorkspaceTemplate({ name: 'B', preset: { tags: ['bug'] } })
    const legacy = createWorkspaceTemplate({ name: 'Legacy', preset: { model: 'legacy' } })
    updateGlobalSettings({ tags: ['api'] })
    const persisted = JSON.parse(fs.readFileSync(tmpFile, 'utf8')).templates
    expect(persisted[0]).toMatchObject({ id: a.id, preset: { tags: ['api'], model: 'm' } })
    expect(persisted[1].preset).toEqual({ tags: [] })
    expect(persisted[2]).toEqual(legacy)
    updateGlobalSettings({ tags: ['bug', 'api'] })
    expect(listWorkspaceTemplates()[0].preset.tags).toEqual(['api'])
    expect(listWorkspaceTemplates()[1].preset.tags).toEqual([])
  })

  it('prevents a stale client from reintroducing removed tags', () => {
    updateGlobalSettings({ tags: ['bug'] })
    const created = createWorkspaceTemplate({ name: 'A', preset: { tags: ['bug'] } })
    updateGlobalSettings({ tags: [] })
    expect(updateWorkspaceTemplate(created.id, { preset: { tags: ['bug'] } })?.preset).toEqual({ tags: [] })
    expect(createWorkspaceTemplate({ name: 'Stale', preset: { tags: ['bug'] } }).preset).toEqual({ tags: [] })
  })

  it('does not erase corrupt template data or delete catalogue tags when cleanup fails', () => {
    updateGlobalSettings({ tags: ['bug'] })
    fs.writeFileSync(tmpFile, '{broken')
    expect(() => updateGlobalSettings({ tags: [] })).toThrow(/workspace-templates/)
    expect(fs.readFileSync(tmpFile, 'utf8')).toBe('{broken')
    expect(getGlobalSettings().tags).toEqual(['bug'])
  })

  it('also cleans templates when importing a catalogue without the old tags', () => {
    updateGlobalSettings({ tags: ['bug', 'api'] })
    createWorkspaceTemplate({ name: 'A', preset: { tags: ['bug', 'api'], tasks: ['Keep task'] } })
    const bundle = exportConfigBundle([])
    bundle.settings.global.tags = ['api']
    importConfigBundle(bundle)
    expect(JSON.parse(fs.readFileSync(tmpFile, 'utf8')).templates[0].preset).toEqual({
      tags: ['api'],
      tasks: ['Keep task'],
    })
  })

  it('filters obsolete tags on read and rename of an older file', () => {
    updateGlobalSettings({ tags: ['api'] })
    const template = createWorkspaceTemplate({ name: 'Old', preset: { tags: ['api'] } })
    fs.writeFileSync(
      tmpFile,
      JSON.stringify({ version: 1, templates: [{ ...template, preset: { tags: ['removed', 'api'] } }] }),
    )
    expect(listWorkspaceTemplates()[0].preset.tags).toEqual(['api'])
    expect(updateWorkspaceTemplate(template.id, { name: 'Renamed' })?.preset.tags).toEqual(['api'])
  })

  it('starts empty when the file does not exist', () => {
    expect(listWorkspaceTemplates()).toEqual([])
  })

  it('creates a template with an id and timestamps, and persists it', () => {
    const created = createWorkspaceTemplate({ name: '  Fix Sentry  ', preset: { engine: 'claude-code' } })

    expect(created.id).toMatch(/^[A-Za-z0-9_-]{10,}$/)
    expect(created.name).toBe('Fix Sentry')
    expect(created.preset).toEqual({ engine: 'claude-code' })
    expect(created.createdAt).toBe(created.updatedAt)
    expect(listWorkspaceTemplates()).toEqual([created])
    expect(JSON.parse(fs.readFileSync(tmpFile, 'utf-8'))).toMatchObject({ version: 1 })
  })

  it('refuses an empty name and a name over 80 characters', () => {
    expect(() => createWorkspaceTemplate({ name: '   ', preset: {} })).toThrow(/Invalid template name/)
    expect(() => createWorkspaceTemplate({ name: 'x'.repeat(81), preset: {} })).toThrow(/Invalid template name/)
  })

  it('refuses a duplicate name, case-insensitively and ignoring surrounding spaces', () => {
    createWorkspaceTemplate({ name: 'Fix Sentry', preset: {} })

    expect(() => createWorkspaceTemplate({ name: ' fix sentry ', preset: {} })).toThrow(/already exists/)
  })

  it('renames and replaces the preset, bumping updatedAt only', () => {
    const created = createWorkspaceTemplate({ name: 'A', preset: { model: 'opus' } })

    try {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(Date.parse(created.createdAt) + 60_000))

      const updated = updateWorkspaceTemplate(created.id, { name: 'B', preset: { model: 'sonnet' } })

      expect(updated).toMatchObject({ id: created.id, name: 'B', preset: { model: 'sonnet' } })
      expect(updated?.createdAt).toBe(created.createdAt)
      expect(updated?.updatedAt).not.toBe(created.updatedAt)
      expect(listWorkspaceTemplates()[0]?.name).toBe('B')
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a rename keep its own name without tripping the duplicate check', () => {
    const created = createWorkspaceTemplate({ name: 'Same', preset: {} })

    const updated = updateWorkspaceTemplate(created.id, { name: 'same ' })

    expect(updated?.name).toBe('same')
  })

  it('returns null when updating or deleting an unknown id', () => {
    expect(updateWorkspaceTemplate('nope', { name: 'x' })).toBeNull()
    expect(deleteWorkspaceTemplate('nope')).toBe(false)
  })

  it('deletes and persists the deletion', () => {
    const created = createWorkspaceTemplate({ name: 'Gone', preset: {} })

    expect(deleteWorkspaceTemplate(created.id)).toBe(true)
    expect(listWorkspaceTemplates()).toEqual([])
  })

  it('stops at the cap', () => {
    for (let i = 0; i < MAX_WORKSPACE_TEMPLATES; i++) createWorkspaceTemplate({ name: `t${i}`, preset: {} })

    expect(() => createWorkspaceTemplate({ name: 'one too many', preset: {} })).toThrow(/Too many templates/)
  })

  it('refuses a corrupt file and preserves it for recovery', () => {
    fs.writeFileSync(tmpFile, '{ not json')
    expect(listWorkspaceTemplates).toThrow(/Failed to read workspace-templates.json/)
    expect(fs.readFileSync(tmpFile, 'utf-8')).toBe('{ not json')
  })
})

describe('presetFromWorkspace', () => {
  let dbTmpDir: string
  let dbPath: string

  async function resetDb() {
    const { closeDb } = await import('../server/db/index.js')
    closeDb()
    dbTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-ws-templates-db-'))
    dbPath = path.join(dbTmpDir, 'test.db')

    const db = new Database(dbPath)
    db.pragma('journal_mode=WAL')
    db.pragma('foreign_keys=ON')
    initSchema(db)
    db.close()
  }

  beforeEach(async () => {
    await resetDb()
    const { getDb } = await import('../server/db/index.js')
    getDb(dbPath)
  })

  afterEach(async () => {
    const { closeDb } = await import('../server/db/index.js')
    closeDb()
    if (dbTmpDir && fs.existsSync(dbTmpDir)) {
      fs.rmSync(dbTmpDir, { recursive: true, force: true })
    }
  })

  async function createFixtureWorkspace(): Promise<string> {
    const { createTask, createWorkspace } = await import('../server/services/workspace-service.js')
    const { getDb } = await import('../server/db/index.js')

    const ws = createWorkspace({
      name: 'Parser crash',
      projectPath: '/tmp/p',
      sourceBranch: 'develop',
      workingBranch: 'fix/parser-crash',
      model: 'gpt',
      reasoningEffort: 'high',
      agentPermissionMode: 'bypass',
      engine: 'codex',
    })

    // Out of order on purpose to exercise the ORDER BY sort_order.
    createTask(ws.id, { title: 'Fix', sortOrder: 2 })
    createTask(ws.id, { title: 'Reproduce', sortOrder: 1 })
    createTask(ws.id, { title: 'No regression', isAcceptanceCriterion: true, sortOrder: 3 })

    const db = getDb()
    db.prepare(
      `UPDATE workspaces SET auto_loop = 1, auto_loop_session_mode = 'continuous', description = ?, brainstorm_model = ? WHERE id = ?`,
    ).run('Crash in the parser', 'opus', ws.id)

    return ws.id
  }

  it('derives every settings field, the description, and the tasks as titles regardless of status', async () => {
    const id = await createFixtureWorkspace()

    expect(presetFromWorkspace(id)).toEqual({
      projectPath: '/tmp/p',
      sourceBranch: 'develop',
      branchType: 'fix',
      engine: 'codex',
      model: 'gpt',
      reasoningEffort: 'high',
      agentPermissionMode: 'bypass',
      autoLoop: true,
      autoLoopSessionMode: 'continuous',
      brainstormModel: 'opus',
      description: 'Crash in the parser',
      tasks: ['Reproduce', 'Fix'],
      acceptanceCriteria: ['No regression'],
    })
  })

  it('omits the branch type when the working branch has no prefix, and null fields', async () => {
    const { createWorkspace } = await import('../server/services/workspace-service.js')
    const { getDb } = await import('../server/db/index.js')

    const ws = createWorkspace({
      name: 'Standalone',
      projectPath: '/tmp/p2',
      sourceBranch: 'develop',
      workingBranch: 'standalone',
    })
    const db = getDb()
    db.prepare(`UPDATE workspaces SET description = NULL, brainstorm_model = NULL WHERE id = ?`).run(ws.id)

    const preset = presetFromWorkspace(ws.id)

    expect(preset).not.toHaveProperty('branchType')
    expect(preset).not.toHaveProperty('brainstormModel')
    expect(preset).not.toHaveProperty('description')
  })

  it('returns null for an unknown workspace', () => {
    expect(presetFromWorkspace('genuinely-missing-id')).toBeNull()
  })

  it('drops an unrecognised agentPermissionMode instead of leaking a legacy value', async () => {
    const id = await createFixtureWorkspace()
    const { getDb } = await import('../server/db/index.js')
    const db = getDb()
    db.prepare(`UPDATE workspaces SET agent_permission_mode = 'legacy-value' WHERE id = ?`).run(id)

    const preset = presetFromWorkspace(id)

    expect(preset).not.toHaveProperty('agentPermissionMode')
  })
})
