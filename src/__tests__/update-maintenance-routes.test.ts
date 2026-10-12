import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initSchema } from '../server/db/schema.js'
import type { SessionController } from '../server/services/agent/session-controller.js'
import { releaseUpdateMaintenance } from '../server/services/update-maintenance-service.js'

vi.mock('../server/services/websocket-service.js', () => ({ emit: vi.fn(), emitEphemeral: vi.fn() }))

const owner = 'a'.repeat(32)
let directory: string

describe('update maintenance HTTP reservation', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-12T10:00:00Z'))
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-maintenance-'))
    const { getDb } = await import('../server/db/index.js')
    initSchema(getDb(path.join(directory, 'test.db')))
  })

  afterEach(async () => {
    releaseUpdateMaintenance(owner)
    const wakeups = await import('../server/services/wakeup-service.js')
    wakeups.suspendForShutdown()
    vi.clearAllTimers()
    vi.useRealTimers()
    const { closeDb } = await import('../server/db/index.js')
    closeDb()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  async function request(method: string, id = owner) {
    const { default: app } = await import('../server/routes/maintenance.js')
    return app.request('/update', {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(method !== 'GET' ? { body: JSON.stringify({ owner: id }) } : {}),
    })
  }

  it('closes agent admission before acknowledging the reservation, and releases only for its owner', async () => {
    const capability = await request('GET')
    expect(await capability.json()).toEqual({ protocol: 1, active: false })
    expect((await request('POST')).status).toBe(200)
    const agents = await import('../server/services/agent/orchestrator.js')
    expect(() => agents.startAgent('unused', '/tmp', 'message')).toThrow(/maintenance/i)
    expect((await request('DELETE', 'b'.repeat(32))).status).toBe(409)
    expect(() => agents.startAgent('unused', '/tmp', 'message')).toThrow(/maintenance/i)
    expect((await request('DELETE')).status).toBe(200)
    expect(() => agents.startAgent('unused', '/tmp', 'message')).toThrow(/not found/i)
  })

  it('refuses an active workspace without closing admission', async () => {
    const { createWorkspace } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'test',
      projectPath: '/tmp',
      sourceBranch: 'main',
      workingBranch: 'feature/test',
    })
    const { getDb } = await import('../server/db/index.js')
    const wakeups = await import('../server/services/wakeup-service.js')
    wakeups.schedule(ws.id, 60, 'unchanged', undefined)
    const before = getDb().prepare('SELECT * FROM pending_wakeups').all()
    getDb().prepare("UPDATE workspaces SET status = 'extracting' WHERE id = ?").run(ws.id)
    expect((await request('POST')).status).toBe(409)
    expect(await (await request('GET')).json()).toEqual({ protocol: 1, active: false })
    expect(getDb().prepare('SELECT * FROM pending_wakeups').all()).toEqual(before)
  })

  it.each([0, 60_000])(
    'keeps a pending wakeup across a long update, including %i ms before stop',
    async (delayBeforeStop) => {
      const { createWorkspace } = await import('../server/services/workspace-service.js')
      const ws = createWorkspace({
        name: 'test',
        projectPath: '/tmp',
        sourceBranch: 'main',
        workingBranch: 'feature/test',
      })
      const { getDb } = await import('../server/db/index.js')
      const wakeups = await import('../server/services/wakeup-service.js')
      wakeups.rehydrate()
      const scheduled = wakeups.schedule(ws.id, 60, 'preserved instruction', 'maintenance test')
      expect((await request('POST')).status).toBe(200)
      await vi.advanceTimersByTimeAsync(delayBeforeStop)
      wakeups.suspendForShutdown()
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      vi.setSystemTime(new Date(new Date(scheduled.targetAt).getTime() + 10 * 60_000))
      releaseUpdateMaintenance(owner)
      expect(Date.now() - new Date(scheduled.targetAt).getTime()).toBeGreaterThan(5 * 60_000)
      wakeups.rehydrate()
      const row = getDb()
        .prepare('SELECT target_at, retry_at, prompt FROM pending_wakeups WHERE workspace_id = ?')
        .get(ws.id)
      expect(row).toEqual({
        target_at: scheduled.targetAt,
        retry_at: scheduled.targetAt,
        prompt: 'preserved instruction',
      })
    },
  )

  it('does not revive a never-attempted wakeup that was stale before maintenance', async () => {
    const { createWorkspace } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'test',
      projectPath: '/tmp',
      sourceBranch: 'main',
      workingBranch: 'feature/test',
    })
    const { getDb } = await import('../server/db/index.js')
    const wakeups = await import('../server/services/wakeup-service.js')
    wakeups.schedule(ws.id, 60, 'stale', undefined)
    getDb()
      .prepare('UPDATE pending_wakeups SET target_at = ? WHERE workspace_id = ?')
      .run(new Date(Date.now() - 600_000).toISOString(), ws.id)
    expect((await request('POST')).status).toBe(200)
    expect(getDb().prepare('SELECT retry_at FROM pending_wakeups').get()).toEqual({ retry_at: null })
  })

  it('rejects a malformed reservation identifier', async () => {
    expect((await request('POST', '')).status).toBe(400)
  })

  it('refuses a persisted running session even when the workspace looks idle', async () => {
    const { createWorkspace } = await import('../server/services/workspace-service.js')
    const ws = createWorkspace({
      name: 'test',
      projectPath: '/tmp',
      sourceBranch: 'main',
      workingBranch: 'feature/test',
    })
    const { getDb } = await import('../server/db/index.js')
    getDb()
      .prepare('INSERT INTO agent_sessions (id, workspace_id, status, started_at) VALUES (?, ?, ?, ?)')
      .run('running', ws.id, 'running', new Date().toISOString())
    expect((await request('POST')).status).toBe(409)
  })

  it('refuses a runtime still closing even when its database session is complete', async () => {
    const agents = await import('../server/services/agent/orchestrator.js')
    agents._getControllers().set('closing', { status: 'stopping' } as SessionController)
    try {
      expect((await request('POST')).status).toBe(409)
    } finally {
      agents._getControllers().delete('closing')
    }
  })
})
