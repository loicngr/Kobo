import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../server/services/workspace-service.js', () => ({
  getWorkspace: vi.fn(),
}))

vi.mock('../server/services/dev-server-service.js', () => ({
  getStatus: vi.fn(),
  startDevServer: vi.fn(),
  stopDevServer: vi.fn(),
  getDevServerLogs: vi.fn(),
}))

// ── Imports (after mocks) ────────────────────────────────────────────────────

import router from '../server/routes/dev-server.js'
import * as devServerService from '../server/services/dev-server-service.js'
import { getWorkspace } from '../server/services/workspace-service.js'

// ── App setup ────────────────────────────────────────────────────────────────

const app = new Hono()
app.route('/api/dev-server', router)

// ── Fixtures ─────────────────────────────────────────────────────────────────

const fakeWorkspace = {
  id: 'ws-1',
  name: 'Test Workspace',
  projectPath: '/tmp/project',
  sourceBranch: 'main',
  workingBranch: 'feature/test',
  status: 'idle' as const,
  notionUrl: null,
  notionPageId: null,
  model: 'claude-opus-4-6',
  devServerStatus: 'stopped',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const fakeStatus = {
  status: 'running' as const,
  instanceName: 'feature-test',
  projectName: 'project',
  httpPort: '8080',
  url: 'http://localhost:8080',
  containers: ['container-1'],
}

// ── Helpers ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/dev-server/:workspaceId/status', () => {
  it('returns dev-server status', async () => {
    vi.mocked(getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(devServerService.getStatus).mockReturnValue(fakeStatus)

    const res = await app.request('/api/dev-server/ws-1/status')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.status).toBe('running')
    expect(data.instanceName).toBe('feature-test')
    expect(devServerService.getStatus).toHaveBeenCalledWith('/tmp/project', 'feature/test', 'ws-1')
  })

  it('falls back to persisted devServerStatus when runtime returns unknown', async () => {
    vi.mocked(getWorkspace).mockReturnValue({
      ...fakeWorkspace,
      devServerStatus: 'running',
    })
    vi.mocked(devServerService.getStatus).mockReturnValue({
      ...fakeStatus,
      status: 'unknown',
    })

    const res = await app.request('/api/dev-server/ws-1/status')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.status).toBe('running')
  })

  it('keeps unknown when persisted status is stopped', async () => {
    vi.mocked(getWorkspace).mockReturnValue({
      ...fakeWorkspace,
      devServerStatus: 'stopped',
    })
    vi.mocked(devServerService.getStatus).mockReturnValue({
      ...fakeStatus,
      status: 'unknown',
    })

    const res = await app.request('/api/dev-server/ws-1/status')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.status).toBe('unknown')
  })

  it('returns 404 for unknown workspace', async () => {
    vi.mocked(getWorkspace).mockReturnValue(null)

    const res = await app.request('/api/dev-server/nonexistent/status')
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toContain('not found')
  })
})

describe('POST /api/dev-server/:workspaceId/start', () => {
  it('starts dev-server and returns status', async () => {
    vi.mocked(getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(devServerService.startDevServer).mockReturnValue(fakeStatus)

    const res = await app.request('/api/dev-server/ws-1/start', { method: 'POST' })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.status).toBe('running')
    expect(devServerService.startDevServer).toHaveBeenCalledWith('ws-1')
  })

  it('returns 404 for unknown workspace', async () => {
    vi.mocked(getWorkspace).mockReturnValue(null)

    const res = await app.request('/api/dev-server/nonexistent/start', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('returns 500 on service error', async () => {
    vi.mocked(getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(devServerService.startDevServer).mockImplementation(() => {
      throw new Error('Docker not running')
    })

    const res = await app.request('/api/dev-server/ws-1/start', { method: 'POST' })
    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error).toBe('Docker not running')
  })
})

describe('POST /api/dev-server/:workspaceId/stop', () => {
  it('stops dev-server and returns status', async () => {
    const stoppedStatus = { ...fakeStatus, status: 'stopped' as const }
    vi.mocked(getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(devServerService.stopDevServer).mockReturnValue(stoppedStatus)

    const res = await app.request('/api/dev-server/ws-1/stop', { method: 'POST' })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.status).toBe('stopped')
    expect(devServerService.stopDevServer).toHaveBeenCalledWith('ws-1')
  })

  it('returns 404 for unknown workspace', async () => {
    vi.mocked(getWorkspace).mockReturnValue(null)

    const res = await app.request('/api/dev-server/nonexistent/stop', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})

describe('GET /api/dev-server/:workspaceId/logs', () => {
  it('returns logs with default tail (200)', async () => {
    vi.mocked(getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(devServerService.getDevServerLogs).mockReturnValue('line1\nline2\n')

    const res = await app.request('/api/dev-server/ws-1/logs')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.logs).toBe('line1\nline2\n')
    expect(devServerService.getDevServerLogs).toHaveBeenCalledWith('ws-1', 200)
  })

  it('returns logs with custom tail parameter', async () => {
    vi.mocked(getWorkspace).mockReturnValue(fakeWorkspace)
    vi.mocked(devServerService.getDevServerLogs).mockReturnValue('line1\n')

    const res = await app.request('/api/dev-server/ws-1/logs?tail=50')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.logs).toBe('line1\n')
    expect(devServerService.getDevServerLogs).toHaveBeenCalledWith('ws-1', 50)
  })

  it('returns 404 for unknown workspace', async () => {
    vi.mocked(getWorkspace).mockReturnValue(null)

    const res = await app.request('/api/dev-server/nonexistent/logs')
    expect(res.status).toBe(404)
  })
})
