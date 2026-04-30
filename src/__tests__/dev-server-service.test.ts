import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock child_process before importing the module under test
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}))

// Mock workspace and settings services
vi.mock('../server/services/workspace-service.js', () => ({
  getWorkspace: vi.fn(),
  updateDevServerStatus: vi.fn(),
}))

vi.mock('../server/services/settings-service.js', () => ({
  getProjectSettings: vi.fn(),
}))

vi.mock('../server/services/websocket-service.js', () => ({
  emitEphemeral: vi.fn(),
}))

import { execSync, spawn } from 'node:child_process'
import {
  _resetTrackedProcessesForTests,
  getDevServerLogs,
  getStatus,
  listRunningContainers,
  parseEnvFile,
  resolveInstance,
  sanitizeBranchName,
  startDevServer,
  stopDevServer,
} from '../server/services/dev-server-service.js'
import { getProjectSettings } from '../server/services/settings-service.js'
import { emitEphemeral } from '../server/services/websocket-service.js'
import { getWorkspace } from '../server/services/workspace-service.js'

beforeEach(() => {
  vi.clearAllMocks()
  _resetTrackedProcessesForTests()
})

// ── sanitizeBranchName ─────────────────────────────────────────────────────────

describe('sanitizeBranchName', () => {
  it('replaces / with - and lowercases', () => {
    expect(sanitizeBranchName('feature/xxx')).toBe('feature-xxx')
  })

  it('handles uppercase branch names', () => {
    expect(sanitizeBranchName('Feature/TK-1121')).toBe('feature-tk-1121')
  })

  it('passes through simple branch names', () => {
    expect(sanitizeBranchName('main')).toBe('main')
  })

  it('replaces _ with -', () => {
    expect(sanitizeBranchName('feature_test/branch')).toBe('feature-test-branch')
  })

  it('handles multiple slashes', () => {
    expect(sanitizeBranchName('refs/heads/feature/test')).toBe('refs-heads-feature-test')
  })
})

// ── parseEnvFile ───────────────────────────────────────────────────────────────

describe('parseEnvFile', () => {
  it('parses standard key=value pairs', () => {
    const content = 'FOO=bar\nBAZ=qux'
    const result = parseEnvFile(content)
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('skips empty lines and comments', () => {
    const content = '# This is a comment\n\nFOO=bar\n\n# Another comment\nBAZ=qux'
    const result = parseEnvFile(content)
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('handles double-quoted values', () => {
    const content = 'FOO="bar baz"'
    const result = parseEnvFile(content)
    expect(result).toEqual({ FOO: 'bar baz' })
  })

  it('handles single-quoted values', () => {
    const content = "FOO='bar baz'"
    const result = parseEnvFile(content)
    expect(result).toEqual({ FOO: 'bar baz' })
  })

  it('handles values with = in them', () => {
    const content = 'FOO=bar=baz'
    const result = parseEnvFile(content)
    expect(result).toEqual({ FOO: 'bar=baz' })
  })

  it('returns empty object for empty content', () => {
    expect(parseEnvFile('')).toEqual({})
  })
})

// ── resolveInstance ────────────────────────────────────────────────────────────

describe('resolveInstance', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-devserver-test-'))
  })

  it('returns config when matching instance found', () => {
    const instancesDir = path.join(tmpDir, '.container', 'instances')
    fs.mkdirSync(instancesDir, { recursive: true })
    fs.writeFileSync(
      path.join(instancesDir, 'app-feature-tk-123.env'),
      'INSTANCE_NAME=feature-tk-123\nPROJECT_NAME=myproject\nHTTP_PORT=8080',
    )

    const result = resolveInstance(tmpDir, 'feature/TK-123')
    expect(result).toEqual({
      instanceName: 'feature-tk-123',
      projectName: 'myproject',
      httpPort: '8080',
    })
  })

  it('returns null when no matching instance', () => {
    const instancesDir = path.join(tmpDir, '.container', 'instances')
    fs.mkdirSync(instancesDir, { recursive: true })
    fs.writeFileSync(
      path.join(instancesDir, 'app-other.env'),
      'INSTANCE_NAME=other-branch\nPROJECT_NAME=myproject\nHTTP_PORT=8080',
    )

    const result = resolveInstance(tmpDir, 'feature/TK-123')
    expect(result).toBeNull()
  })

  it('returns null when instances directory does not exist', () => {
    const result = resolveInstance(tmpDir, 'feature/TK-123')
    expect(result).toBeNull()
  })

  it('skips non-env files', () => {
    const instancesDir = path.join(tmpDir, '.container', 'instances')
    fs.mkdirSync(instancesDir, { recursive: true })
    fs.writeFileSync(
      path.join(instancesDir, 'readme.txt'),
      'INSTANCE_NAME=feature-tk-123\nPROJECT_NAME=myproject\nHTTP_PORT=8080',
    )

    const result = resolveInstance(tmpDir, 'feature/TK-123')
    expect(result).toBeNull()
  })
})

// ── listRunningContainers ──────────────────────────────────────────────────────

describe('listRunningContainers', () => {
  it('parses docker ps output into array', () => {
    vi.mocked(execSync).mockReturnValue('container-a\ncontainer-b\ncontainer-c\n')
    const result = listRunningContainers()
    expect(result).toEqual(['container-a', 'container-b', 'container-c'])
  })

  it('returns empty array when docker command fails', () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('docker not found')
    })
    const result = listRunningContainers()
    expect(result).toEqual([])
  })

  it('handles empty output', () => {
    vi.mocked(execSync).mockReturnValue('')
    const result = listRunningContainers()
    expect(result).toEqual([])
  })

  it('trims whitespace from container names', () => {
    vi.mocked(execSync).mockReturnValue('  container-a  \n  container-b  \n')
    const result = listRunningContainers()
    expect(result).toEqual(['container-a', 'container-b'])
  })
})

// ── getStatus ──────────────────────────────────────────────────────────────────

describe('getStatus', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-devserver-status-'))
  })

  it('returns running status when containers match', () => {
    const instancesDir = path.join(tmpDir, '.container', 'instances')
    fs.mkdirSync(instancesDir, { recursive: true })
    fs.writeFileSync(
      path.join(instancesDir, 'app.env'),
      'INSTANCE_NAME=feature-test\nPROJECT_NAME=myapp\nHTTP_PORT=3000',
    )

    vi.mocked(execSync).mockReturnValue('myapp-web-1\nmyapp-db-1\nother-app-1\n')

    const status = getStatus(tmpDir, 'feature/test')
    expect(status.status).toBe('running')
    expect(status.containers).toEqual(['myapp-web-1', 'myapp-db-1'])
    expect(status.url).toBe('http://localhost:3000')
    expect(status.instanceName).toBe('feature-test')
    expect(status.projectName).toBe('myapp')
  })

  it('returns stopped status when no containers match', () => {
    const instancesDir = path.join(tmpDir, '.container', 'instances')
    fs.mkdirSync(instancesDir, { recursive: true })
    fs.writeFileSync(
      path.join(instancesDir, 'app.env'),
      'INSTANCE_NAME=feature-test\nPROJECT_NAME=myapp\nHTTP_PORT=3000',
    )

    vi.mocked(execSync).mockReturnValue('other-app-1\nunrelated-service\n')

    const status = getStatus(tmpDir, 'feature/test')
    expect(status.status).toBe('stopped')
    expect(status.containers).toEqual([])
    expect(status.url).toBe('')
  })

  it('returns unknown status when no instance config found', () => {
    const status = getStatus(tmpDir, 'feature/nonexistent')
    expect(status.status).toBe('unknown')
    expect(status.instanceName).toBe('')
    expect(status.containers).toEqual([])
  })

  it('returns starting when a start process is in flight and no containers visible yet', () => {
    const instancesDir = path.join(tmpDir, '.container', 'instances')
    fs.mkdirSync(instancesDir, { recursive: true })
    fs.writeFileSync(
      path.join(instancesDir, 'app.env'),
      'INSTANCE_NAME=feature-test\nPROJECT_NAME=myapp\nHTTP_PORT=3000',
    )

    // 1) Simulate a running Docker build: spawn() returns a mock proc that never
    //    fires 'exit'. startDevServer registers it in trackedProcesses.
    vi.mocked(getWorkspace).mockReturnValue({
      id: 'ws-build',
      name: 'Test',
      projectPath: tmpDir,
      sourceBranch: 'main',
      workingBranch: 'feature/test',
      status: 'idle',
      notionUrl: null,
      notionPageId: null,
      model: 'auto',
      createdAt: '',
      updatedAt: '',
    })
    vi.mocked(getProjectSettings).mockReturnValue({
      path: tmpDir,
      displayName: 'Test',
      defaultSourceBranch: 'main',
      defaultModel: 'auto',
      prPromptTemplate: '',
      devServer: { startCommand: 'docker compose up -d', stopCommand: '' },
    })
    const mockProc = { on: vi.fn(), kill: vi.fn(), stdout: null, stderr: null, pid: 1234 }
    vi.mocked(spawn).mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>)
    startDevServer('ws-build')

    // 2) Polling hits getStatus() mid-build — docker ps still shows nothing matching.
    vi.mocked(execSync).mockReturnValue('other-container\n')

    const status = getStatus(tmpDir, 'feature/test', 'ws-build')
    expect(status.status).toBe('starting')
  })

  it('returns stopped when no tracked process and no containers match', () => {
    const instancesDir = path.join(tmpDir, '.container', 'instances')
    fs.mkdirSync(instancesDir, { recursive: true })
    fs.writeFileSync(
      path.join(instancesDir, 'app.env'),
      'INSTANCE_NAME=feature-test\nPROJECT_NAME=myapp\nHTTP_PORT=3000',
    )
    vi.mocked(execSync).mockReturnValue('other-app\n')

    const status = getStatus(tmpDir, 'feature/test', 'ws-not-tracked')
    expect(status.status).toBe('stopped')
  })

  it('prefers running over starting when containers are visible even if a process is tracked', () => {
    const instancesDir = path.join(tmpDir, '.container', 'instances')
    fs.mkdirSync(instancesDir, { recursive: true })
    fs.writeFileSync(
      path.join(instancesDir, 'app.env'),
      'INSTANCE_NAME=feature-test\nPROJECT_NAME=myapp\nHTTP_PORT=3000',
    )

    vi.mocked(getWorkspace).mockReturnValue({
      id: 'ws-running',
      name: 'Test',
      projectPath: tmpDir,
      sourceBranch: 'main',
      workingBranch: 'feature/test',
      status: 'idle',
      notionUrl: null,
      notionPageId: null,
      model: 'auto',
      createdAt: '',
      updatedAt: '',
    })
    vi.mocked(getProjectSettings).mockReturnValue({
      path: tmpDir,
      displayName: 'Test',
      defaultSourceBranch: 'main',
      defaultModel: 'auto',
      prPromptTemplate: '',
      devServer: { startCommand: 'docker compose up -d', stopCommand: '' },
    })
    const mockProc = { on: vi.fn(), kill: vi.fn(), stdout: null, stderr: null, pid: 1234 }
    vi.mocked(spawn).mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>)
    startDevServer('ws-running')

    vi.mocked(execSync).mockReturnValue('myapp-web-1\n')

    const status = getStatus(tmpDir, 'feature/test', 'ws-running')
    expect(status.status).toBe('running')
  })
})

// ── startDevServer ─────────────────────────────────────────────────────────────

describe('startDevServer', () => {
  it('throws when workspace not found', () => {
    vi.mocked(getWorkspace).mockReturnValue(null)
    expect(() => startDevServer('ws-1')).toThrow("Workspace 'ws-1' not found")
  })

  it('throws when no start command configured', () => {
    vi.mocked(getWorkspace).mockReturnValue({
      id: 'ws-1',
      name: 'Test',
      projectPath: '/project',
      sourceBranch: 'main',
      workingBranch: 'feature/test',
      status: 'executing',
      notionUrl: null,
      notionPageId: null,
      model: 'auto',
      createdAt: '',
      updatedAt: '',
    })
    vi.mocked(getProjectSettings).mockReturnValue(null)

    expect(() => startDevServer('ws-1')).toThrow('No dev-server start command configured')
  })

  it('spawns process and returns starting status', () => {
    vi.mocked(getWorkspace).mockReturnValue({
      id: 'ws-1',
      name: 'Test',
      projectPath: '/project',
      sourceBranch: 'main',
      workingBranch: 'feature/test',
      status: 'executing',
      notionUrl: null,
      notionPageId: null,
      model: 'auto',
      createdAt: '',
      updatedAt: '',
    })
    vi.mocked(getProjectSettings).mockReturnValue({
      path: '/project',
      displayName: 'Test',
      defaultSourceBranch: 'main',
      defaultModel: 'auto',
      prPromptTemplate: '',
      devServer: { startCommand: 'make dev-server', stopCommand: '' },
    })

    const mockProc = {
      on: vi.fn(),
      kill: vi.fn(),
      stdout: null,
      stderr: null,
      pid: 1234,
    }
    vi.mocked(spawn).mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>)

    const status = startDevServer('ws-1')

    expect(status.status).toBe('starting')
    expect(status.instanceName).toBe('feature-test')
    expect(spawn).toHaveBeenCalledWith(
      'bash',
      ['-c', 'make dev-server'],
      expect.objectContaining({
        cwd: '/project',
        env: expect.objectContaining({
          INSTANCE: 'feature-test',
          DEV_DOCKER_NO_FOLLOW: '1',
        }),
      }),
    )
    expect(emitEphemeral).toHaveBeenCalledWith(
      'ws-1',
      'devserver:status',
      expect.objectContaining({
        status: 'starting',
      }),
    )
  })
})

// ── stopDevServer ──────────────────────────────────────────────────────────────

describe('stopDevServer', () => {
  it('throws when workspace not found', () => {
    vi.mocked(getWorkspace).mockReturnValue(null)
    expect(() => stopDevServer('ws-1')).toThrow("Workspace 'ws-1' not found")
  })

  it('emits stopped status', () => {
    vi.mocked(getWorkspace).mockReturnValue({
      id: 'ws-1',
      name: 'Test',
      projectPath: '/tmp/nonexistent-project-path',
      sourceBranch: 'main',
      workingBranch: 'feature/test',
      status: 'executing',
      notionUrl: null,
      notionPageId: null,
      model: 'auto',
      createdAt: '',
      updatedAt: '',
    })
    vi.mocked(getProjectSettings).mockReturnValue(null)

    const status = stopDevServer('ws-1')

    expect(status.status).toBe('stopped')
    expect(emitEphemeral).toHaveBeenCalledWith(
      'ws-1',
      'devserver:status',
      expect.objectContaining({
        status: 'stopped',
      }),
    )
  })
})

// ── getDevServerLogs ───────────────────────────────────────────────────────────

describe('getDevServerLogs', () => {
  it('returns message when workspace not found', () => {
    vi.mocked(getWorkspace).mockReturnValue(null)
    const logs = getDevServerLogs('ws-1')
    expect(logs).toBe('Workspace not found')
  })

  it('returns message when no instance config', () => {
    vi.mocked(getWorkspace).mockReturnValue({
      id: 'ws-1',
      name: 'Test',
      projectPath: '/tmp/nonexistent-project-path',
      sourceBranch: 'main',
      workingBranch: 'feature/test',
      status: 'executing',
      notionUrl: null,
      notionPageId: null,
      model: 'auto',
      createdAt: '',
      updatedAt: '',
    })
    const logs = getDevServerLogs('ws-1')
    expect(logs).toBe('No dev-server instance found')
  })
})
