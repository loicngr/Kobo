import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initSchema } from '../server/db/schema.js'

let tmpDir: string
let dbPath: string

async function resetDb() {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-hook-test-'))
  dbPath = path.join(tmpDir, 'test.db')
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
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

describe('shouldNudgeWakeup (pure decision)', () => {
  const base = {
    stopHookActive: false,
    backgroundTaskCount: 1,
    sdkScheduledWakeupCount: 0,
    koboWakeupScheduled: false,
  }

  it('nudges when background work runs with no wakeup scheduled', async () => {
    const { shouldNudgeWakeup } = await import('../server/services/agent/engines/claude-code/stop-hook.js')
    expect(shouldNudgeWakeup(base)).toBe(true)
  })

  it('does not nudge when there is no in-flight background work', async () => {
    const { shouldNudgeWakeup } = await import('../server/services/agent/engines/claude-code/stop-hook.js')
    expect(shouldNudgeWakeup({ ...base, backgroundTaskCount: 0 })).toBe(false)
  })

  it('does not nudge when an SDK-level cron/wakeup is already scheduled', async () => {
    const { shouldNudgeWakeup } = await import('../server/services/agent/engines/claude-code/stop-hook.js')
    expect(shouldNudgeWakeup({ ...base, sdkScheduledWakeupCount: 1 })).toBe(false)
  })

  it('does not nudge when a Kōbō wakeup is already scheduled', async () => {
    const { shouldNudgeWakeup } = await import('../server/services/agent/engines/claude-code/stop-hook.js')
    expect(shouldNudgeWakeup({ ...base, koboWakeupScheduled: true })).toBe(false)
  })

  it('does not nudge again when the stop hook is already active (anti-loop)', async () => {
    const { shouldNudgeWakeup } = await import('../server/services/agent/engines/claude-code/stop-hook.js')
    expect(shouldNudgeWakeup({ ...base, stopHookActive: true })).toBe(false)
  })
})

describe('buildNudgeText', () => {
  it('mentions schedule_wakeup and the background-task count', async () => {
    const { buildNudgeText } = await import('../server/services/agent/engines/claude-code/stop-hook.js')
    const text = buildNudgeText(3)
    expect(text).toContain('kobo__schedule_wakeup')
    expect(text).toContain('3')
  })
})

describe('buildStopHookOutput (with Kōbō pending_wakeups cross-check)', () => {
  it('returns a Stop additionalContext nudge when bg work runs and no Kōbō wakeup is pending', async () => {
    const { createWorkspace } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'W', projectPath: '/tmp/p', sourceBranch: 'main', workingBranch: 'feature/x' })
    const { buildStopHookOutput } = await import('../server/services/agent/engines/claude-code/stop-hook.js')

    const out = buildStopHookOutput(ws.id, {
      stop_hook_active: false,
      background_tasks: [{ id: 'bg1' }],
      session_crons: [],
    })
    expect(out.hookSpecificOutput?.hookEventName).toBe('Stop')
    expect(out.hookSpecificOutput?.additionalContext).toContain('kobo__schedule_wakeup')
  })

  it('injects nothing when a Kōbō wakeup is already scheduled for the workspace', async () => {
    const { createWorkspace } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'W', projectPath: '/tmp/p', sourceBranch: 'main', workingBranch: 'feature/x' })
    const wakeup = await import('../server/services/wakeup-service.js')
    wakeup.schedule(ws.id, 120, 'check the CI run', 'test')

    const { buildStopHookOutput } = await import('../server/services/agent/engines/claude-code/stop-hook.js')
    const out = buildStopHookOutput(ws.id, {
      stop_hook_active: false,
      background_tasks: [{ id: 'bg1' }],
      session_crons: [],
    })
    expect(out).toEqual({})
  })

  it('injects nothing on a clean stop (no background work)', async () => {
    const { createWorkspace } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({ name: 'W', projectPath: '/tmp/p', sourceBranch: 'main', workingBranch: 'feature/x' })
    const { buildStopHookOutput } = await import('../server/services/agent/engines/claude-code/stop-hook.js')

    const out = buildStopHookOutput(ws.id, {
      stop_hook_active: false,
      background_tasks: [],
      session_crons: [],
    })
    expect(out).toEqual({})
  })
})
