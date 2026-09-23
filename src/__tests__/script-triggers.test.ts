import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initSchema } from '../server/db/schema.js'

// Mock the shared script runner so the cleanup/archive hooks never spawn a
// real bash process — we only assert whether (and how) they invoke it.
vi.mock('../server/utils/script-runner.js', () => ({
  runScript: vi.fn().mockResolvedValue({ exitCode: 0 }),
  SCRIPT_TIMEOUT_MS: 300_000,
}))

// Mock only `worktreeHasChanges` so the "only on changes" gate is controllable
// without a real git repo; keep every other git-ops function intact.
vi.mock('../server/utils/git-ops.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/utils/git-ops.js')>()),
  worktreeHasChanges: vi.fn(() => true),
}))

import * as archiveScriptService from '../server/services/archive-script-service.js'
import * as cleanupScriptService from '../server/services/cleanup-script-service.js'
import { _setSettingsPath, getSettings, updateGlobalSettings } from '../server/services/settings-service.js'
import { createTask, createWorkspace } from '../server/services/workspace-service.js'
import { worktreeHasChanges } from '../server/utils/git-ops.js'
import { runScript } from '../server/utils/script-runner.js'

let tmpDir: string
let dbPath: string
let worktreeDir: string

async function resetDb() {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-script-triggers-'))
  dbPath = path.join(tmpDir, 'test.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode=WAL')
  db.pragma('foreign_keys=ON')
  initSchema(db)
  db.close()
}

beforeEach(async () => {
  vi.clearAllMocks()
  await resetDb()
  const { getDb } = await import('../server/db/index.js')
  getDb(dbPath)
  _setSettingsPath(path.join(tmpDir, 'settings.json'))
  getSettings() // materialize defaults
  worktreeDir = path.join(tmpDir, 'worktree')
  fs.mkdirSync(worktreeDir, { recursive: true })
})

afterEach(async () => {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

function makeWorkspace(): string {
  return createWorkspace({
    name: 'WS',
    projectPath: '/tmp/proj',
    sourceBranch: 'main',
    workingBranch: 'feature/x',
    worktreePath: worktreeDir,
  }).id
}

describe('cleanup-script-service triggers', () => {
  it('runs the cleanup script after a clean standalone session (mode idle)', () => {
    updateGlobalSettings({ cleanupScript: 'echo done', cleanupScriptMode: 'idle' })
    const id = makeWorkspace()

    cleanupScriptService.onSessionEnded(id, 'completed', { wasAutoLoop: false })

    expect(runScript).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runScript).mock.calls[0][0].eventPrefix).toBe('cleanup')
  })

  it('never runs after a mid-loop session (wasAutoLoop)', () => {
    updateGlobalSettings({ cleanupScript: 'echo done', cleanupScriptMode: 'idle' })
    const id = makeWorkspace()

    cleanupScriptService.onSessionEnded(id, 'completed', { wasAutoLoop: true })

    expect(runScript).not.toHaveBeenCalled()
  })

  it('does not run when the session ended with an error', () => {
    updateGlobalSettings({ cleanupScript: 'echo done', cleanupScriptMode: 'idle' })
    const id = makeWorkspace()

    cleanupScriptService.onSessionEnded(id, 'error', { wasAutoLoop: false })

    expect(runScript).not.toHaveBeenCalled()
  })

  it('mode no-tasks skips when a pending task remains', () => {
    updateGlobalSettings({ cleanupScript: 'echo done', cleanupScriptMode: 'no-tasks' })
    const id = makeWorkspace()
    createTask(id, { title: 'still todo' })

    cleanupScriptService.onSessionEnded(id, 'completed', { wasAutoLoop: false })

    expect(runScript).not.toHaveBeenCalled()
  })

  it('mode no-tasks runs when no task remains', () => {
    updateGlobalSettings({ cleanupScript: 'echo done', cleanupScriptMode: 'no-tasks' })
    const id = makeWorkspace()

    cleanupScriptService.onSessionEnded(id, 'completed', { wasAutoLoop: false })

    expect(runScript).toHaveBeenCalledTimes(1)
  })

  it('onAutoLoopCompleted runs the cleanup even with pending tasks left', () => {
    updateGlobalSettings({ cleanupScript: 'echo done', cleanupScriptMode: 'no-tasks' })
    const id = makeWorkspace()
    createTask(id, { title: 'still todo' })

    cleanupScriptService.onAutoLoopCompleted(id)

    expect(runScript).toHaveBeenCalledTimes(1)
  })

  it('does nothing when no cleanup script is configured', () => {
    const id = makeWorkspace()

    cleanupScriptService.onSessionEnded(id, 'completed', { wasAutoLoop: false })

    expect(runScript).not.toHaveBeenCalled()
  })

  it('onlyOnChanges skips when the worktree has no uncommitted changes', () => {
    updateGlobalSettings({
      cleanupScript: 'echo done',
      cleanupScriptMode: 'idle',
      cleanupScriptOnlyOnChanges: true,
    })
    vi.mocked(worktreeHasChanges).mockReturnValue(false)
    const id = makeWorkspace()

    cleanupScriptService.onSessionEnded(id, 'completed', { wasAutoLoop: false })

    expect(runScript).not.toHaveBeenCalled()
  })

  it('onlyOnChanges runs when the worktree has uncommitted changes', () => {
    updateGlobalSettings({
      cleanupScript: 'echo done',
      cleanupScriptMode: 'idle',
      cleanupScriptOnlyOnChanges: true,
    })
    vi.mocked(worktreeHasChanges).mockReturnValue(true)
    const id = makeWorkspace()

    cleanupScriptService.onSessionEnded(id, 'completed', { wasAutoLoop: false })

    expect(runScript).toHaveBeenCalledTimes(1)
  })
})

describe('archive-script-service trigger', () => {
  it('runs the archive script when a workspace is archived', () => {
    updateGlobalSettings({ archiveScript: 'echo archived' })
    const id = makeWorkspace()

    archiveScriptService.onWorkspaceArchived(id)

    expect(runScript).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runScript).mock.calls[0][0].eventPrefix).toBe('archive')
  })

  it('does nothing when no archive script is configured', () => {
    const id = makeWorkspace()

    archiveScriptService.onWorkspaceArchived(id)

    expect(runScript).not.toHaveBeenCalled()
  })
})
