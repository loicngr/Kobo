import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initSchema } from '../server/db/schema.js'
import type { SessionController } from '../server/services/agent/session-controller.js'

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

  it('delivers a wakeup only to its matching, running controller', async () => {
    const orch = await import('../server/services/agent/orchestrator.js')
    const ws = await import('../server/services/websocket-service.js')
    const sendWakeupIfWaiting = vi.fn(() => true)
    const controller = {
      agentSessionId: 'session-1',
      status: 'running',
      engineProcess: { sendWakeupIfWaiting },
    }
    orch._getControllers().set(wsId, controller as unknown as SessionController)
    try {
      expect(orch.sendWakeupIfWaiting(wsId, 'check logs', 'different-session')).toBe(false)
      controller.status = 'stopping'
      expect(orch.sendWakeupIfWaiting(wsId, 'check logs', 'session-1')).toBe(false)
      expect(sendWakeupIfWaiting).not.toHaveBeenCalled()

      controller.status = 'running'
      expect(orch.sendWakeupIfWaiting(wsId, 'check logs', 'session-1')).toBe(true)
      expect(sendWakeupIfWaiting).toHaveBeenCalledWith('check logs')
      expect(ws.emit).toHaveBeenCalledWith(
        wsId,
        'user:message',
        { content: 'check logs', sender: 'system-prompt' },
        'session-1',
      )
    } finally {
      orch._getControllers().delete(wsId)
    }
  })

  it.each(['awaiting-user', 'quota', 'archived', 'purged'])(
    'defers wakeups for a workspace that is %s',
    async (state) => {
      const orch = await import('../server/services/agent/orchestrator.js')
      const db = (await import('../server/db/index.js')).getDb()
      if (state === 'archived')
        db.prepare('UPDATE workspaces SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), wsId)
      else if (state === 'purged')
        db.prepare('UPDATE workspaces SET worktree_purged_at = ? WHERE id = ?').run(new Date().toISOString(), wsId)
      else db.prepare('UPDATE workspaces SET status = ? WHERE id = ?').run(state, wsId)
      const sendWakeupIfWaiting = vi.fn(() => true)
      orch._getControllers().set(wsId, {
        agentSessionId: 'session-1',
        status: 'running',
        engineProcess: { sendWakeupIfWaiting },
      } as unknown as SessionController)
      try {
        expect(orch.sendWakeupIfWaiting(wsId, 'check logs', 'session-1')).toBe(false)
        expect(sendWakeupIfWaiting).not.toHaveBeenCalled()
      } finally {
        orch._getControllers().delete(wsId)
      }
    },
  )

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

    expect(scheduleSpy).toHaveBeenCalledWith(wsId, 60, 'resume', 'CI', 'session-1')
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
