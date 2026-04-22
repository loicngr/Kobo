import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initSchema } from '../server/db/schema.js'

// Mock websocket-service so tests don't open sockets.
vi.mock('../server/services/websocket-service.js', () => ({
  emit: vi.fn(),
  emitEphemeral: vi.fn(),
}))

// Mock event-router so handleEvent doesn't try to touch the real DB routing path.
vi.mock('../server/services/agent/event-router.js', () => ({
  routeEvent: vi.fn(),
}))

let tmpDir: string
let dbPath: string

async function resetDb() {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-orch-wakeup-'))
  dbPath = path.join(tmpDir, 'test.db')

  const db = new Database(dbPath)
  db.pragma('journal_mode=WAL')
  db.pragma('foreign_keys=ON')
  initSchema(db)
  db.close()
}

describe('orchestrator — ScheduleWakeup detection in handleEvent', () => {
  let wsId: string

  beforeEach(async () => {
    await resetDb()
    const { getDb } = await import('../server/db/index.js')
    getDb(dbPath)

    const { createWorkspace } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'w',
      projectPath: '/tmp/p',
      sourceBranch: 'main',
      workingBranch: 'feature/x',
    })
    wsId = ws.id

    vi.clearAllMocks()
  })

  afterEach(async () => {
    const { closeDb } = await import('../server/db/index.js')
    closeDb()
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('invokes wakeupService.schedule on tool:call ScheduleWakeup with valid input', async () => {
    const wakeup = await import('../server/services/wakeup-service.js')
    const scheduleSpy = vi.spyOn(wakeup, 'schedule').mockImplementation(() => undefined)
    const orch = await import('../server/services/agent/orchestrator.js')

    orch.__test__.handleEvent(wsId, 'session-1', {
      kind: 'tool:call',
      messageId: 'm1',
      toolCallId: 'c1',
      name: 'ScheduleWakeup',
      input: { delaySeconds: 60, prompt: 'resume', reason: 'CI' },
    })

    expect(scheduleSpy).toHaveBeenCalledWith(wsId, 60, 'resume', 'CI')
  })

  it('ignores ScheduleWakeup with missing delaySeconds or prompt', async () => {
    const wakeup = await import('../server/services/wakeup-service.js')
    const scheduleSpy = vi.spyOn(wakeup, 'schedule').mockImplementation(() => undefined)
    const orch = await import('../server/services/agent/orchestrator.js')

    orch.__test__.handleEvent(wsId, 'session-1', {
      kind: 'tool:call',
      messageId: 'm1',
      toolCallId: 'c1',
      name: 'ScheduleWakeup',
      input: { delaySeconds: 0, prompt: '' },
    })

    expect(scheduleSpy).not.toHaveBeenCalled()
  })

  it('ignores non-ScheduleWakeup tool calls', async () => {
    const wakeup = await import('../server/services/wakeup-service.js')
    const scheduleSpy = vi.spyOn(wakeup, 'schedule').mockImplementation(() => undefined)
    const orch = await import('../server/services/agent/orchestrator.js')

    orch.__test__.handleEvent(wsId, 'session-1', {
      kind: 'tool:call',
      messageId: 'm1',
      toolCallId: 'c1',
      name: 'Bash',
      input: { command: 'ls' },
    })

    expect(scheduleSpy).not.toHaveBeenCalled()
  })
})
