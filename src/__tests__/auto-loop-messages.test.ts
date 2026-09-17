import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initSchema } from '../server/db/schema.js'

vi.mock('../server/services/websocket-service.js', () => ({
  emit: vi.fn(),
  emitEphemeral: vi.fn(),
}))

vi.mock('../server/services/agent/orchestrator.js', () => ({
  startAgent: vi.fn(() => ({ agentSessionId: 'mock-agent-session-id' })),
  hasController: vi.fn(() => false),
  runningAgentCount: vi.fn(() => 0),
  isShuttingDown: vi.fn(() => false),
  resetAutoLoopRetries: vi.fn(),
}))

vi.mock('../server/services/lifecycle-hook-service.js', () => ({
  onAutoLoopDisabled: vi.fn(async () => {}),
}))

vi.mock('../server/services/settings-service.js', () => ({
  getProjectSettings: vi.fn(),
  getGlobalSettings: vi.fn(() => ({
    worktreesPath: '',
    worktreesPrefixByProject: false,
  })),
  // Finalization now resolves through the project||global cascade; default to
  // empty (inherit) so only the dedicated finalization tests opt into a prompt.
  getEffectiveFinalization: vi.fn(() => ({ prompt: '' })),
}))

let tmpDir: string
let dbPath: string

async function resetDb() {
  const { closeDb } = await import('../server/db/index.js')
  closeDb()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-autoloop-'))
  dbPath = path.join(tmpDir, 'test.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode=WAL')
  db.pragma('foreign_keys=ON')
  initSchema(db)
  db.close()
}

describe('durable auto-loop messages', () => {
  let wsId: string

  beforeEach(async () => {
    await resetDb()
    const { getDb } = await import('../server/db/index.js')
    getDb(dbPath)
    const { createWorkspace } = await import('../server/services/workspace-service.js')
    // Use the test's tmpDir as project path so the worktree pre-check
    // (fs.existsSync on projectPath/.worktrees/workingBranch) passes.
    const worktreesDir = path.join(tmpDir, '.worktrees', 'feature', 'x')
    fs.mkdirSync(worktreesDir, { recursive: true })
    const ws = createWorkspace({
      name: 'w',
      projectPath: tmpDir,
      sourceBranch: 'main',
      workingBranch: 'feature/x',
    })
    wsId = ws.id
    vi.clearAllMocks()
  })

  afterEach(async () => {
    const { closeDb } = await import('../server/db/index.js')
    closeDb()
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('persists and deduplicates queued instructions while a controller owns the workspace', async () => {
    const { getDb } = await import('../server/db/index.js')
    const svc = await import('../server/services/auto-loop-service.js')
    const orch = await import('../server/services/agent/orchestrator.js')
    vi.mocked(orch.hasController).mockReturnValue(true)
    getDb().prepare('UPDATE workspaces SET auto_loop=1 WHERE id=?').run(wsId)
    expect(svc.queueInstruction(wsId, 'New requirement', 'message-1')).toBe(true)
    expect(svc.queueInstruction(wsId, 'New requirement', 'message-1')).toBe(true)
    expect(getDb().prepare('SELECT content,state FROM auto_loop_messages WHERE workspace_id=?').all(wsId)).toEqual([
      { content: 'New requirement', state: 'pending' },
    ])
    expect(() => svc.queueInstruction(wsId, 'Different content', 'message-1')).toThrow(/different/)
    expect(orch.startAgent).not.toHaveBeenCalled()
    vi.mocked(orch.hasController).mockReturnValue(false)
    svc.rehydrate()
    expect(orch.startAgent).toHaveBeenCalledWith(
      wsId,
      expect.any(String),
      expect.stringContaining('New requirement'),
      expect.any(String),
      true,
      expect.any(String),
      undefined,
      expect.any(String),
    )
    expect(getDb().prepare('SELECT state FROM auto_loop_messages WHERE workspace_id=?').get(wsId)).toEqual({
      state: 'dispatching',
    })
    svc.onSessionEnded(wsId, 'completed', 0)
    expect(getDb().prepare('SELECT state FROM auto_loop_messages WHERE workspace_id=?').get(wsId)).toEqual({
      state: 'delivered',
    })
  })

  it('pauses instead of resending an instruction whose delivery was interrupted', async () => {
    const { getDb } = await import('../server/db/index.js')
    const svc = await import('../server/services/auto-loop-service.js')
    getDb().prepare('UPDATE workspaces SET auto_loop=1 WHERE id=?').run(wsId)
    getDb()
      .prepare(
        "INSERT INTO auto_loop_messages(workspace_id,client_message_id,content,state,created_at) VALUES (?,?,?,'dispatching','now')",
      )
      .run(wsId, 'message-2', 'Maybe delivered')
    svc.rehydrate()
    expect(svc.getStatus(wsId)).toMatchObject({ auto_loop: true, state: 'blocked' })
    const orch = await import('../server/services/agent/orchestrator.js')
    expect(orch.startAgent).not.toHaveBeenCalled()
    expect(getDb().prepare('SELECT state FROM auto_loop_messages WHERE workspace_id=?').get(wsId)).toEqual({
      state: 'unknown',
    })
  })
  it('acknowledges an already accepted instruction after the user has stopped the loop', async () => {
    const { getDb } = await import('../server/db/index.js')
    const svc = await import('../server/services/auto-loop-service.js')
    const orch = await import('../server/services/agent/orchestrator.js')
    vi.mocked(orch.hasController).mockReturnValue(true)
    getDb().prepare('UPDATE workspaces SET auto_loop=1 WHERE id=?').run(wsId)
    expect(svc.queueInstruction(wsId, 'accepted', 'stable-id')).toBe(true)
    svc.disable(wsId, 'user-action')
    expect(svc.queueInstruction(wsId, 'accepted', 'stable-id')).toBe(true)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM auto_loop_messages').get()).toEqual({ n: 1 })
    expect(orch.startAgent).not.toHaveBeenCalled()
    vi.mocked(orch.hasController).mockReturnValue(false)
  })

  it('reconciles interrupted deliveries even for a disabled loop', async () => {
    const { getDb } = await import('../server/db/index.js')
    const svc = await import('../server/services/auto-loop-service.js')
    getDb()
      .prepare(
        "INSERT INTO auto_loop_messages(workspace_id,client_message_id,content,state,created_at) VALUES (?,?,?,'dispatching','now')",
      )
      .run(wsId, 'stopped', 'unknown')
    svc.rehydrate()
    expect(getDb().prepare('SELECT state FROM auto_loop_messages').get()).toEqual({ state: 'unknown' })
    expect(svc.getStatus(wsId).auto_loop).toBe(false)
  })
})
