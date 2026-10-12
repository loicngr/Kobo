import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { HonoRequest } from 'hono/request'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: undefined as unknown as Database.Database }))
vi.mock('../server/db/index.js', () => ({ getDb: () => state.db }))
vi.mock('../server/services/websocket-service.js', () => ({ emitEphemeral: vi.fn() }))

import { initSchema } from '../server/db/schema.js'
import router from '../server/routes/progress-bars.js'
import { createProgressBar, updateProgressBar } from '../server/services/progress-bar-service.js'
import { emitEphemeral } from '../server/services/websocket-service.js'

const scope = { workspaceId: 'w1', sessionId: 's1' }
const owner = { ...scope, kind: 'internal' as const, launchId: 'private-launch' }
const app = new Hono().route('/api/progress-bars', router)
beforeEach(() => {
  state.db = new Database(':memory:')
  state.db.pragma('foreign_keys=ON')
  initSchema(state.db)
  state.db.exec(
    `INSERT INTO workspaces(id,name,project_path,source_branch,working_branch,created_at,updated_at) VALUES ('w1','W','/tmp','main','f','now','now'); INSERT INTO agent_sessions(id,workspace_id,started_at) VALUES ('s1','w1','now')`,
  )
  vi.clearAllMocks()
})
afterEach(() => state.db.close())
it('requires an existing workspace/session pair and validates pagination', async () => {
  for (const query of [
    '',
    '?workspaceId=w1',
    '?workspaceId=w2&sessionId=s1',
    '?workspaceId=w1&sessionId=s1&limit=101',
    '?workspaceId=w1&sessionId=s1&offset=-1',
  ]) {
    const response = await app.request(`/api/progress-bars${query}`)
    expect([400, 404]).toContain(response.status)
  }
})
it('returns sanitized progress with pagination and dismisses only within matching scope', async () => {
  const bar = createProgressBar(owner, { activityKey: 'tests', label: 'Tests' })
  const list = await app.request('/api/progress-bars?workspaceId=w1&sessionId=s1')
  expect(list.status).toBe(200)
  const body = await list.json()
  expect(body).toMatchObject({
    items: [{ id: bar.id, dismissed: false }],
    nextOffset: null,
    totalCount: 1,
    serverTime: expect.any(String),
  })
  expect(JSON.stringify(body)).not.toContain('private-launch')
  expect(JSON.stringify(body)).not.toContain('fingerprint')
  const dismiss = (value: unknown) =>
    app.request(`/api/progress-bars/${bar.id}/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    })
  expect((await dismiss({ workspaceId: 'w2', sessionId: 's1' })).status).toBe(404)
  const hidden = await (await dismiss(scope)).json()
  expect(hidden).toMatchObject({ dismissed: true, dismissedAt: expect.any(String), revision: 2 })
  expect(await (await dismiss(scope)).json()).toEqual(hidden)
  expect(updateProgressBar(owner, bar.id, { sequence: 1, step: 'Still running' }).dismissed).toBe(true)
})
it('rejects malformed dismissal without mutation and survives deletion races', async () => {
  const bar = createProgressBar(owner, { activityKey: 'tests', label: 'Tests' })
  vi.mocked(emitEphemeral).mockClear()
  const bad = await app.request(`/api/progress-bars/${bar.id}/dismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  })
  expect(bad.status).toBe(400)
  state.db.exec("DELETE FROM agent_sessions WHERE id='s1'")
  const gone = await app.request(`/api/progress-bars/${bar.id}/dismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scope),
  })
  expect(gone.status).toBe(404)
  expect(emitEphemeral).not.toHaveBeenCalled()
})

it('bounds request body before parsing JSON', async () => {
  const response = await app.request('/api/progress-bars/id/dismiss', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId: 'x'.repeat(20_000), sessionId: 's1' }),
  })
  expect(response.status).toBe(413)
})

it('revalidates the launch capability after asynchronous body reading', async () => {
  const { createProgressCapability, revokeProgressCapability } = await import(
    '../server/services/progress-bar-runtime.js'
  )
  const capability = createProgressCapability('w1', 's1')
  let release!: () => void
  let parsing!: () => void
  const started = new Promise<void>((resolve) => {
    parsing = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const original = HonoRequest.prototype.json
  const json = vi.spyOn(HonoRequest.prototype, 'json').mockImplementation(async function (this: HonoRequest) {
    parsing()
    await gate
    return original.call(this)
  })
  try {
    const pending = app.request('/api/progress-bars/agent/create_progress_bar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kobo-Progress-Session': capability.token },
      body: JSON.stringify({ activity_key: 'delayed', label: 'Delayed task' }),
    })
    await started
    revokeProgressCapability(capability.token)
    release()
    const response = await pending
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'invalid_capability' })
    expect(state.db.prepare('SELECT count(*) AS n FROM session_progress_bars').get()).toEqual({ n: 0 })
    expect(emitEphemeral).not.toHaveBeenCalled()
  } finally {
    release()
    json.mockRestore()
    revokeProgressCapability(capability.token)
  }
})
