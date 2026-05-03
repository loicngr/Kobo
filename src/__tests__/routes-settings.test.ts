import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../server/services/settings-service.js', () => ({
  getSettings: vi.fn(),
  getGlobalSettings: vi.fn(),
  updateGlobalSettings: vi.fn(),
  listActiveClaudeMcpServers: vi.fn(),
  listProjects: vi.fn(),
  getProjectSettings: vi.fn(),
  upsertProject: vi.fn(),
  deleteProject: vi.fn(),
}))

// ── Imports (after mocks) ────────────────────────────────────────────────────

import router from '../server/routes/settings.js'
import * as settingsService from '../server/services/settings-service.js'

// ── App setup ────────────────────────────────────────────────────────────────

const app = new Hono()
app.route('/api/settings', router)

// ── Fixtures ─────────────────────────────────────────────────────────────────

const fakeGlobalSettings = {
  defaultModel: 'auto',
  prPromptTemplate: '',
}

const fakeProject = {
  path: '/home/user/project',
  displayName: 'My Project',
  defaultSourceBranch: 'main',
  defaultModel: 'claude-opus-4-6',
  prPromptTemplate: '',
  devServer: {
    startCommand: '',
    stopCommand: '',
  },
}

const fakeSettings = {
  global: fakeGlobalSettings,
  projects: [fakeProject],
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function encodeProjectPath(projectPath: string): string {
  return Buffer.from(projectPath).toString('base64url')
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/settings', () => {
  it('returns full settings', async () => {
    vi.mocked(settingsService.getSettings).mockReturnValue(fakeSettings)

    const res = await app.request('/api/settings')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toEqual(fakeSettings)
    expect(settingsService.getSettings).toHaveBeenCalledOnce()
  })

  it('returns 500 on service error', async () => {
    vi.mocked(settingsService.getSettings).mockImplementation(() => {
      throw new Error('File read error')
    })

    const res = await app.request('/api/settings')
    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error).toBe('File read error')
  })
})

describe('GET /api/settings/global', () => {
  it('returns global settings', async () => {
    vi.mocked(settingsService.getGlobalSettings).mockReturnValue(fakeGlobalSettings)

    const res = await app.request('/api/settings/global')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toEqual(fakeGlobalSettings)
    expect(settingsService.getGlobalSettings).toHaveBeenCalledOnce()
  })
})

describe('GET /api/settings/mcp-servers', () => {
  it('returns active MCP servers only', async () => {
    vi.mocked(settingsService.listActiveClaudeMcpServers).mockReturnValue([
      { key: 'notion', command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'] },
      { key: 'sentry', command: 'npx', args: ['-y', '@sentry/mcp-server'] },
    ])

    const res = await app.request('/api/settings/mcp-servers')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toEqual([
      { key: 'notion', command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'] },
      { key: 'sentry', command: 'npx', args: ['-y', '@sentry/mcp-server'] },
    ])
  })

  it('returns 500 on service error', async () => {
    vi.mocked(settingsService.listActiveClaudeMcpServers).mockImplementation(() => {
      throw new Error('Read failed')
    })

    const res = await app.request('/api/settings/mcp-servers')
    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error).toBe('Read failed')
  })
})

describe('PUT /api/settings/global', () => {
  it('updates global settings', async () => {
    const updated = { defaultModel: 'claude-sonnet-4-20250514', prPromptTemplate: 'New template' }
    vi.mocked(settingsService.updateGlobalSettings).mockReturnValue(updated)

    const res = await app.request('/api/settings/global', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultModel: 'claude-sonnet-4-20250514' }),
    })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toEqual(updated)
    expect(settingsService.updateGlobalSettings).toHaveBeenCalledWith({ defaultModel: 'claude-sonnet-4-20250514' })
  })

  it('returns 500 on service error', async () => {
    vi.mocked(settingsService.updateGlobalSettings).mockImplementation(() => {
      throw new Error('Write failed')
    })

    const res = await app.request('/api/settings/global', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultModel: 'bad' }),
    })

    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error).toBe('Write failed')
  })

  it('returns 400 when the worktrees path is invalid', async () => {
    vi.mocked(settingsService.updateGlobalSettings).mockImplementation(() => {
      const err = new Error('Worktrees path cannot contain parent directory traversal (`..`)')
      err.name = 'InvalidWorktreesPathError'
      throw err
    })

    const res = await app.request('/api/settings/global', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worktreesPath: '../outside' }),
    })

    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toContain('parent directory traversal')
  })
})

describe('GET /api/settings/projects', () => {
  it('returns project list', async () => {
    vi.mocked(settingsService.listProjects).mockReturnValue([fakeProject])

    const res = await app.request('/api/settings/projects')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toEqual([fakeProject])
    expect(settingsService.listProjects).toHaveBeenCalledOnce()
  })

  it('returns empty array when no projects', async () => {
    vi.mocked(settingsService.listProjects).mockReturnValue([])

    const res = await app.request('/api/settings/projects')
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toEqual([])
  })
})

describe('GET /api/settings/projects/:encodedPath', () => {
  it('returns project settings for valid path', async () => {
    vi.mocked(settingsService.getProjectSettings).mockReturnValue(fakeProject)
    const encoded = encodeProjectPath('/home/user/project')

    const res = await app.request(`/api/settings/projects/${encoded}`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toEqual(fakeProject)
    expect(settingsService.getProjectSettings).toHaveBeenCalledWith('/home/user/project')
  })

  it('returns 404 for unknown project', async () => {
    vi.mocked(settingsService.getProjectSettings).mockReturnValue(null)
    const encoded = encodeProjectPath('/nonexistent/path')

    const res = await app.request(`/api/settings/projects/${encoded}`)
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.error).toContain('Project not found')
  })
})

describe('PUT /api/settings/projects/:encodedPath', () => {
  it('upserts project settings', async () => {
    vi.mocked(settingsService.upsertProject).mockReturnValue(fakeProject)
    const encoded = encodeProjectPath('/home/user/project')

    const res = await app.request(`/api/settings/projects/${encoded}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'My Project', defaultSourceBranch: 'main' }),
    })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toEqual(fakeProject)
    expect(settingsService.upsertProject).toHaveBeenCalledWith('/home/user/project', {
      displayName: 'My Project',
      defaultSourceBranch: 'main',
    })
  })

  it('returns 500 on service error', async () => {
    vi.mocked(settingsService.upsertProject).mockImplementation(() => {
      throw new Error('Validation failed')
    })
    const encoded = encodeProjectPath('/home/user/project')

    const res = await app.request(`/api/settings/projects/${encoded}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: '' }),
    })

    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error).toBe('Validation failed')
  })
})

describe('DELETE /api/settings/projects/:encodedPath', () => {
  it('deletes project and returns 204', async () => {
    vi.mocked(settingsService.deleteProject).mockReturnValue(undefined as any)
    const encoded = encodeProjectPath('/home/user/project')

    const res = await app.request(`/api/settings/projects/${encoded}`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(settingsService.deleteProject).toHaveBeenCalledWith('/home/user/project')
  })

  it('returns 500 on service error', async () => {
    vi.mocked(settingsService.deleteProject).mockImplementation(() => {
      throw new Error('Delete failed')
    })
    const encoded = encodeProjectPath('/home/user/project')

    const res = await app.request(`/api/settings/projects/${encoded}`, { method: 'DELETE' })
    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data.error).toBe('Delete failed')
  })
})
