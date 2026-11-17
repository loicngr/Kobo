import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initSchema } from '../server/db/schema.js'
import type { SessionController } from '../server/services/agent/session-controller.js'
import { releaseUpdateMaintenance } from '../server/services/update-maintenance-service.js'

vi.mock('../server/services/websocket-service.js', () => ({ emit: vi.fn(), emitEphemeral: vi.fn() }))
vi.mock('../server/services/update-trigger-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/services/update-trigger-service.js')>()),
  getUpdateTriggerState: vi.fn(),
  requestUpdate: vi.fn(),
  pollUpdateTrigger: vi.fn(),
  reportUpdateTrigger: vi.fn(),
  isStopAgentsRequest: vi.fn(),
}))

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

describe('update trigger routes', () => {
  async function call(method: string, path: string, body?: unknown) {
    const { default: app } = await import('../server/routes/maintenance.js')
    return app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  async function service() {
    return await import('../server/services/update-trigger-service.js')
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the state', async () => {
    const svc = await service()
    const state = { available: true, pending: false, inProgress: false, status: null, runningAgents: 0, busy: false }
    vi.mocked(svc.getUpdateTriggerState).mockReturnValue(state)
    const res = await call('GET', '/update-trigger')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(state)
  })

  it('accepts a request with 202 and its id', async () => {
    const svc = await service()
    vi.mocked(svc.requestUpdate).mockReturnValue({
      id: 'req1',
      skipBackup: true,
      stopAgents: false,
      requestedAt: '2026-01-01T00:00:00.000Z',
    })
    const res = await call('POST', '/update-trigger', { skipBackup: true, stopAgents: false })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ id: 'req1' })
    expect(svc.requestUpdate).toHaveBeenCalledWith({ skipBackup: true, stopAgents: false })
  })

  it.each([{ skipBackup: 'yes', stopAgents: false }, { skipBackup: true }, {}])(
    'rejects a non-boolean body %j',
    async (body) => {
      expect((await call('POST', '/update-trigger', body)).status).toBe(400)
    },
  )

  it.each(['unavailable', 'pending', 'in-progress', 'busy'] as const)('maps %s to 409 with its code', async (code) => {
    const svc = await service()
    vi.mocked(svc.requestUpdate).mockImplementation(() => {
      throw new svc.UpdateTriggerError(code)
    })
    const res = await call('POST', '/update-trigger', { skipBackup: false, stopAgents: false })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: new svc.UpdateTriggerError(code).message, code })
  })

  it('hands the polled request out', async () => {
    const svc = await service()
    const request = { id: 'req1', skipBackup: false, stopAgents: true, requestedAt: '2026-01-01T00:00:00.000Z' }
    vi.mocked(svc.pollUpdateTrigger).mockReturnValueOnce(request).mockReturnValueOnce(null)
    expect(await (await call('GET', '/update-trigger/poll')).json()).toEqual({ protocol: 1, request })
    expect(await (await call('GET', '/update-trigger/poll')).json()).toEqual({ protocol: 1, request: null })
  })

  it('records a report', async () => {
    const svc = await service()
    vi.mocked(svc.reportUpdateTrigger).mockReturnValue(true)
    const res = await call('POST', '/update-trigger/report', { id: 'req1', phase: 'refused', reason: 'busy' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ protocol: 1 })
    expect(svc.reportUpdateTrigger).toHaveBeenCalledWith('req1', 'refused', 'busy')
  })

  it('rejects values outside the fixed sets', async () => {
    expect((await call('POST', '/update-trigger/report', { id: 'req1', phase: 'nope' })).status).toBe(400)
    expect(
      (await call('POST', '/update-trigger/report', { id: 'req1', phase: 'refused', reason: 'nope' })).status,
    ).toBe(400)
    expect((await call('POST', '/update-trigger/report', { phase: 'refused' })).status).toBe(400)
  })

  it('refuses stop-agents for a request without stopAgents, without reserving', async () => {
    const svc = await service()
    vi.mocked(svc.isStopAgentsRequest).mockReturnValue(false)
    const res = await call('POST', '/update-trigger/stop-agents', { id: 'req1', owner: 'c'.repeat(32) })
    expect(res.status).toBe(409)
    expect(svc.isStopAgentsRequest).toHaveBeenCalledWith('req1')
    expect(await (await call('GET', '/update')).json()).toEqual({ protocol: 1, active: false })
  })

  it.each([
    {},
    { id: 'req1' },
    { id: 'req1', owner: 'short' },
    { id: 'req1', owner: 'C'.repeat(32) },
    { owner: 'c'.repeat(32) },
  ])('rejects a malformed stop-agents body %j', async (body) => {
    expect((await call('POST', '/update-trigger/stop-agents', body)).status).toBe(400)
  })

  it('answers 409 for an unknown report id', async () => {
    const svc = await service()
    vi.mocked(svc.reportUpdateTrigger).mockReturnValue(false)
    expect((await call('POST', '/update-trigger/report', { id: 'old', phase: 'building' })).status).toBe(409)
  })
})
