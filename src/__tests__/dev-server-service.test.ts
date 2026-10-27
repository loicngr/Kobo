import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock child_process before importing the module under test
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}))

// Mock workspace and settings services
vi.mock('../server/services/workspace-service.js', () => ({
  getWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  updateDevServerStatus: vi.fn(),
}))

vi.mock('../server/services/settings-service.js', () => ({
  getProjectSettings: vi.fn(),
  getGlobalSettings: vi.fn(() => ({ serializeDevServerStarts: true, maxRunningDevServers: 0 })),
}))

vi.mock('../server/services/websocket-service.js', () => ({
  emitEphemeral: vi.fn(),
}))

import { execFile, spawn } from 'node:child_process'
import {
  _resetTrackedProcessesForTests,
  getDevServerLogs,
  getStatus,
  listRunningContainers,
  parseEnvFile,
  resolveInstance,
  resumeQueuedDevServers,
  sanitizeBranchName,
  startDevServer,
  stopAllDevServers,
  stopDevServer,
} from '../server/services/dev-server-service.js'
import { getGlobalSettings, getProjectSettings } from '../server/services/settings-service.js'
import { emitEphemeral } from '../server/services/websocket-service.js'
import { getWorkspace, listWorkspaces, updateDevServerStatus } from '../server/services/workspace-service.js'
import { makeProjectSettings, makeWorkspace } from './helpers/fixtures.js'

beforeEach(() => {
  vi.clearAllMocks()
  _resetTrackedProcessesForTests()
  vi.mocked(listWorkspaces).mockReturnValue([])
  vi.mocked(getGlobalSettings).mockReturnValue({ serializeDevServerStarts: true, maxRunningDevServers: 0 } as never)
})

function mockCommandOutput(output: string): void {
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1) as (err: Error | null, stdout: string, stderr: string) => void
    callback(null, output, '')
    return {}
  }) as never)
}

function mockCommandFailure(error: Error): void {
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1) as (err: Error | null, stdout: string, stderr: string) => void
    callback(error, '', '')
    return {}
  }) as never)
}

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

  it('ignores a matching instance with no Docker project name', () => {
    const instancesDir = path.join(tmpDir, '.container', 'instances')
    fs.mkdirSync(instancesDir, { recursive: true })
    fs.writeFileSync(path.join(instancesDir, 'broken.env'), 'INSTANCE_NAME=feature-tk-123\nHTTP_PORT=8080')
    expect(resolveInstance(tmpDir, 'feature/TK-123')).toBeNull()
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
  it('parses docker ps output into array', async () => {
    mockCommandOutput('container-a\ncontainer-b\ncontainer-c\n')
    const result = await listRunningContainers()
    expect(result).toEqual(['container-a', 'container-b', 'container-c'])
  })

  it('returns empty array when docker command fails', async () => {
    mockCommandFailure(new Error('docker not found'))
    const result = await listRunningContainers()
    expect(result).toEqual([])
  })

  it('handles empty output', async () => {
    mockCommandOutput('')
    const result = await listRunningContainers()
    expect(result).toEqual([])
  })

  it('trims whitespace from container names', async () => {
    mockCommandOutput('  container-a  \n  container-b  \n')
    const result = await listRunningContainers()
    expect(result).toEqual(['container-a', 'container-b'])
  })
})

// ── getStatus ──────────────────────────────────────────────────────────────────

describe('getStatus', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-devserver-status-'))
  })

  it('uses the exact Compose label, including custom container names', async () => {
    fs.mkdirSync(path.join(tmpDir, '.container/instances'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, '.container/instances/foo.env'),
      'INSTANCE_NAME=foo\nPROJECT_NAME=foo\nHTTP_PORT=3000',
    )
    mockCommandOutput('friendly-name\tfoo\nfoo-bar-web-1\tfoo-bar\nfoo_extra-web-1\tfoo_extra\n')
    expect((await getStatus(tmpDir, 'foo')).containers).toEqual(['friendly-name'])
    expect(execFile).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['--filter', 'label=com.docker.compose.project=foo']),
      expect.anything(),
      expect.anything(),
    )
  })

  it('returns running status when containers match', async () => {
    const instancesDir = path.join(tmpDir, '.container', 'instances')
    fs.mkdirSync(instancesDir, { recursive: true })
    fs.writeFileSync(
      path.join(instancesDir, 'app.env'),
      'INSTANCE_NAME=feature-test\nPROJECT_NAME=myapp\nHTTP_PORT=3000',
    )

    mockCommandOutput('myapp-web-1\tmyapp\nmyapp-db-1\tmyapp\nother-app-1\tother-app\n')

    const status = await getStatus(tmpDir, 'feature/test')
    expect(status.status).toBe('running')
    expect(status.containers).toEqual(['myapp-web-1', 'myapp-db-1'])
    expect(status.url).toBe('http://localhost:3000')
    expect(status.instanceName).toBe('feature-test')
    expect(status.projectName).toBe('myapp')
  })

  it('returns stopped status when no containers match', async () => {
    const instancesDir = path.join(tmpDir, '.container', 'instances')
    fs.mkdirSync(instancesDir, { recursive: true })
    fs.writeFileSync(
      path.join(instancesDir, 'app.env'),
      'INSTANCE_NAME=feature-test\nPROJECT_NAME=myapp\nHTTP_PORT=3000',
    )

    mockCommandOutput('other-app-1\nunrelated-service\n')

    const status = await getStatus(tmpDir, 'feature/test')
    expect(status.status).toBe('stopped')
    expect(status.containers).toEqual([])
    expect(status.url).toBe('')
  })

  it('does not match a project name as a substring of another project', async () => {
    const instancesDir = path.join(tmpDir, '.container', 'instances')
    fs.mkdirSync(instancesDir, { recursive: true })
    fs.writeFileSync(path.join(instancesDir, 'app.env'), 'INSTANCE_NAME=feature-test\nPROJECT_NAME=app\nHTTP_PORT=3000')
    mockCommandOutput('myapp-web-1\nunrelated-app-worker\n')

    expect((await getStatus(tmpDir, 'feature/test')).status).toBe('stopped')
  })

  it('returns unknown status when no instance config found', async () => {
    const status = await getStatus(tmpDir, 'feature/nonexistent')
    expect(status.status).toBe('unknown')
    expect(status.instanceName).toBe('')
    expect(status.containers).toEqual([])
  })

  it('returns starting when a start process is in flight and no containers visible yet', async () => {
    const instancesDir = path.join(tmpDir, '.container', 'instances')
    fs.mkdirSync(instancesDir, { recursive: true })
    fs.writeFileSync(
      path.join(instancesDir, 'app.env'),
      'INSTANCE_NAME=feature-test\nPROJECT_NAME=myapp\nHTTP_PORT=3000',
    )

    // 1) Simulate a running Docker build: spawn() returns a mock proc that never
    //    fires 'exit'. startDevServer registers it in trackedProcesses.
    vi.mocked(getWorkspace).mockReturnValue(
      makeWorkspace({
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
      }),
    )
    vi.mocked(getProjectSettings).mockReturnValue(
      makeProjectSettings({
        path: tmpDir,
        displayName: 'Test',
        defaultSourceBranch: 'main',
        defaultModel: 'auto',
        prPromptTemplate: '',
        devServer: { startCommand: 'docker compose up -d', stopCommand: '' },
      }),
    )
    const mockProc = { on: vi.fn(), kill: vi.fn(), stdout: null, stderr: null, pid: 1234 }
    vi.mocked(spawn).mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>)
    startDevServer('ws-build')

    // 2) Polling hits getStatus() mid-build — docker ps still shows nothing matching.
    mockCommandOutput('other-container\n')

    const status = await getStatus(tmpDir, 'feature/test', 'ws-build')
    expect(status.status).toBe('starting')
  })

  it('returns stopped when no tracked process and no containers match', async () => {
    const instancesDir = path.join(tmpDir, '.container', 'instances')
    fs.mkdirSync(instancesDir, { recursive: true })
    fs.writeFileSync(
      path.join(instancesDir, 'app.env'),
      'INSTANCE_NAME=feature-test\nPROJECT_NAME=myapp\nHTTP_PORT=3000',
    )
    mockCommandOutput('other-app\n')

    const status = await getStatus(tmpDir, 'feature/test', 'ws-not-tracked')
    expect(status.status).toBe('stopped')
  })

  it('retains starting while the Docker boot command is still in flight', async () => {
    const instancesDir = path.join(tmpDir, '.container', 'instances')
    fs.mkdirSync(instancesDir, { recursive: true })
    fs.writeFileSync(
      path.join(instancesDir, 'app.env'),
      'INSTANCE_NAME=feature-test\nPROJECT_NAME=myapp\nHTTP_PORT=3000',
    )

    vi.mocked(getWorkspace).mockReturnValue(
      makeWorkspace({
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
      }),
    )
    vi.mocked(getProjectSettings).mockReturnValue(
      makeProjectSettings({
        path: tmpDir,
        displayName: 'Test',
        defaultSourceBranch: 'main',
        defaultModel: 'auto',
        prPromptTemplate: '',
        devServer: { startCommand: 'docker compose up -d', stopCommand: '' },
      }),
    )
    const mockProc = { on: vi.fn(), kill: vi.fn(), stdout: null, stderr: null, pid: 1234 }
    vi.mocked(spawn).mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>)
    startDevServer('ws-running')

    mockCommandOutput('myapp-web-1\tmyapp\n')

    const status = await getStatus(tmpDir, 'feature/test', 'ws-running')
    expect(status.status).toBe('starting')
  })
})

// ── startDevServer ─────────────────────────────────────────────────────────────

describe('startDevServer', () => {
  it('throws when workspace not found', () => {
    vi.mocked(getWorkspace).mockReturnValue(null)
    expect(() => startDevServer('ws-1')).toThrow("Workspace 'ws-1' not found")
  })

  it('throws when no start command configured', () => {
    vi.mocked(getWorkspace).mockReturnValue(
      makeWorkspace({
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
      }),
    )
    vi.mocked(getProjectSettings).mockReturnValue(null)

    expect(() => startDevServer('ws-1')).toThrow('No dev-server start command configured')
  })

  it('spawns process and returns starting status', () => {
    vi.mocked(getWorkspace).mockReturnValue(
      makeWorkspace({
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
      }),
    )
    vi.mocked(getProjectSettings).mockReturnValue(
      makeProjectSettings({
        path: '/project',
        displayName: 'Test',
        defaultSourceBranch: 'main',
        defaultModel: 'auto',
        prPromptTemplate: '',
        devServer: { startCommand: 'make dev-server', stopCommand: '' },
      }),
    )

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

  it('throws instead of silently orphaning the first process on a double start', () => {
    vi.mocked(getWorkspace).mockReturnValue(
      makeWorkspace({
        id: 'ws_double',
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
      }),
    )
    vi.mocked(getProjectSettings).mockReturnValue(
      makeProjectSettings({
        path: '/project',
        displayName: 'Test',
        defaultSourceBranch: 'main',
        defaultModel: 'auto',
        prPromptTemplate: '',
        devServer: { startCommand: 'make dev-server', stopCommand: '' },
      }),
    )

    const mockProc = {
      on: vi.fn(),
      kill: vi.fn(),
      stdout: null,
      stderr: null,
      pid: 1234,
    }
    vi.mocked(spawn).mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>)

    const first = startDevServer('ws_double')
    expect(first.status).toBe('starting')

    expect(() => startDevServer('ws_double')).toThrow(/already starting/i)
  })
})

// ── stopDevServer ──────────────────────────────────────────────────────────────

describe('direct dev servers', () => {
  function launch() {
    const proc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      exitCode: null as number | null,
      signalCode: null,
      kill: vi.fn(),
    })
    vi.mocked(getWorkspace).mockReturnValue(
      makeWorkspace({ id: 'direct', projectPath: '/tmp/no-instance', workingBranch: 'feature/test' }),
    )
    vi.mocked(getProjectSettings).mockReturnValue(
      makeProjectSettings({ devServer: { startCommand: 'npm run dev', stopCommand: '' } }),
    )
    vi.mocked(spawn).mockReturnValue(proc as never)
    startDevServer('direct')
    return proc
  }

  it('reports starting while a direct server has not announced its URL', async () => {
    launch()
    expect(await getStatus('/tmp/no-instance', 'feature/test', 'direct')).toMatchObject({
      status: 'starting',
      url: '',
    })
  })

  it.each(['stdout', 'stderr'] as const)('detects the Quasar App URL on %s across colored chunks', async (stream) => {
    const proc = launch()
    proc[stream].emit('data', Buffer.from(' » App URL................. \u001b[32mhttp://local'))
    proc[stream].emit('data', Buffer.from('host:9000/\u001b[0m\n    http://192.168.1.48:9000/\n'))
    const expected = { status: 'running', httpPort: '9000', url: 'http://localhost:9000/', containers: [] }
    expect(await getStatus('/tmp/no-instance', 'feature/test', 'direct')).toMatchObject(expected)
    expect(updateDevServerStatus).toHaveBeenLastCalledWith('direct', 'running')
    expect(emitEphemeral).toHaveBeenLastCalledWith('direct', 'devserver:status', expect.objectContaining(expected))
    expect(execFile).not.toHaveBeenCalled()
  })

  it('detects a Vite local URL and retains it across status polls', async () => {
    const proc = launch()
    proc.stdout.emit('data', Buffer.from('  ➜  Local:   http://localhost:5173/\n'))
    expect(await getStatus('/tmp/no-instance', 'feature/test', 'direct')).toMatchObject({
      status: 'running',
      httpPort: '5173',
      url: 'http://localhost:5173/',
    })
  })

  it('does not treat documentation or remote URLs as readiness', async () => {
    const proc = launch()
    proc.stdout.emit('data', Buffer.from('Documentation: https://quasar.dev\nLocal: https://example.com:9000/\n'))
    expect(await getStatus('/tmp/no-instance', 'feature/test', 'direct')).toMatchObject({ status: 'starting', url: '' })
  })

  it('clears the URL after exit and ignores late output from the old launch', async () => {
    const proc = launch()
    proc.stdout.emit('data', Buffer.from('App URL........ http://localhost:9000/\n'))
    proc.exitCode = 0
    proc.emit('exit', 0)
    await vi.waitFor(() => expect(updateDevServerStatus).toHaveBeenLastCalledWith('direct', 'unknown'))
    launch()
    proc.stdout.emit('data', Buffer.from('App URL........ http://localhost:9999/\n'))
    expect(await getStatus('/tmp/no-instance', 'feature/test', 'direct')).toMatchObject({ status: 'starting', url: '' })
  })

  it('ignores readiness output once stopping begins', async () => {
    const proc = launch()
    const stopping = stopDevServer('direct')
    proc.stdout.emit('data', Buffer.from('App URL........ http://localhost:9000/\n'))
    expect(updateDevServerStatus).not.toHaveBeenCalledWith('direct', 'running')
    proc.exitCode = 0
    proc.emit('exit', 0)
    await stopping
  })
})

describe('stopDevServer', () => {
  it('throws when workspace not found', async () => {
    vi.mocked(getWorkspace).mockReturnValue(null)
    await expect(stopDevServer('ws-1')).rejects.toThrow("Workspace 'ws-1' not found")
  })

  it('emits stopped status', async () => {
    vi.mocked(getWorkspace).mockReturnValue(
      makeWorkspace({
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
      }),
    )
    vi.mocked(getProjectSettings).mockReturnValue(null)

    const status = await stopDevServer('ws-1')

    expect(status.status).toBe('stopped')
    expect(emitEphemeral).toHaveBeenCalledWith(
      'ws-1',
      'devserver:status',
      expect.objectContaining({
        status: 'stopped',
      }),
    )
  })

  it('stops every persisted workspace during shutdown', async () => {
    const workspaces = [
      { id: 'ws-1', projectPath: '/tmp/one', workingBranch: 'feature/one', worktreePath: '/tmp/one' },
      { id: 'ws-2', projectPath: '/tmp/two', workingBranch: 'feature/two', worktreePath: '/tmp/two' },
    ]
    vi.mocked(listWorkspaces).mockReturnValue(workspaces as never)
    vi.mocked(getWorkspace).mockImplementation((id) => workspaces.find((workspace) => workspace.id === id) as never)
    vi.mocked(getProjectSettings).mockReturnValue(null)

    await stopAllDevServers()

    expect(emitEphemeral).toHaveBeenCalledWith(
      'ws-1',
      'devserver:status',
      expect.objectContaining({ status: 'stopped' }),
    )
    expect(emitEphemeral).toHaveBeenCalledWith(
      'ws-2',
      'devserver:status',
      expect.objectContaining({ status: 'stopped' }),
    )
  })
})

// ── getDevServerLogs ───────────────────────────────────────────────────────────

describe('getDevServerLogs', () => {
  it('returns message when workspace not found', async () => {
    vi.mocked(getWorkspace).mockReturnValue(null)
    const logs = await getDevServerLogs('ws-1')
    expect(logs).toBe('Workspace not found')
  })

  it('returns message when no instance config', async () => {
    vi.mocked(getWorkspace).mockReturnValue(
      makeWorkspace({
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
      }),
    )
    const logs = await getDevServerLogs('ws-1')
    expect(logs).toBe('No dev-server instance found')
  })
})

it('rejects a dev-server start while lifecycle teardown owns the workspace', async () => {
  const { withWorkspaceLifecycleGuard } = await import('../server/utils/workspace-lifecycle-guard.js')
  vi.mocked(getWorkspace).mockReturnValue(makeWorkspace({ id: 'ws-1' }))
  vi.mocked(getProjectSettings).mockReturnValue(
    makeProjectSettings({ devServer: { startCommand: 'npm run dev', stopCommand: '' } }),
  )
  await withWorkspaceLifecycleGuard('ws-1', async () => {
    expect(() => startDevServer('ws-1')).toThrow(/operation is in progress/)
    expect(spawn).not.toHaveBeenCalled()
  })
})

it('retains a stopping process and ignores its stale events after replacement', async () => {
  const child = () =>
    Object.assign(new EventEmitter(), {
      stdout: null,
      stderr: null,
      exitCode: null as number | null,
      signalCode: null,
      kill: vi.fn(),
    })
  const a = child(),
    b = child()
  vi.mocked(getWorkspace).mockReturnValue(
    makeWorkspace({ id: 'ws-race', projectPath: '/tmp/no-dev-config', worktreePath: '/tmp/no-dev-config' }),
  )
  vi.mocked(getProjectSettings).mockReturnValue(
    makeProjectSettings({ devServer: { startCommand: 'npm run dev', stopCommand: '' } }),
  )
  vi.mocked(spawn)
    .mockReturnValueOnce(a as never)
    .mockReturnValueOnce(b as never)
  startDevServer('ws-race')
  const stopping = stopDevServer('ws-race')
  expect(() => startDevServer('ws-race')).toThrow(/stopping|already starting/)
  a.exitCode = 0
  a.emit('exit', 0)
  await stopping
  startDevServer('ws-race')
  a.emit('exit', 0)
  a.emit('error', new Error('old process error'))
  const stopB = stopDevServer('ws-race')
  expect(b.kill).toHaveBeenCalledWith('SIGTERM')
  b.exitCode = 0
  b.emit('exit', 0)
  await stopB
})

it.each(['empty', 'running', 'unavailable'])(
  'verifies Compose state after a successful custom stop and failed fallback: %s',
  async (dockerState) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-custom-stop-'))
    try {
      fs.mkdirSync(path.join(dir, '.container/instances'), { recursive: true })
      fs.writeFileSync(path.join(dir, '.container/instances/foo.env'), 'INSTANCE_NAME=foo\nPROJECT_NAME=foo\n')
      vi.mocked(getWorkspace).mockReturnValue(
        makeWorkspace({ id: 'w', projectPath: dir, worktreePath: dir, workingBranch: 'foo' }),
      )
      vi.mocked(getProjectSettings).mockReturnValue(
        makeProjectSettings({ devServer: { startCommand: 'true', stopCommand: 'custom-stop' } }),
      )
      vi.mocked(execFile).mockImplementation(((command: string, args: string[], ...rest: unknown[]) => {
        const callback = rest.at(-1) as (err: Error | null, stdout: string) => void
        if (command === 'bash') callback(null, '')
        else if (args[0] === 'ps') {
          if (dockerState === 'unavailable') callback(new Error('daemon unreachable'), '')
          else callback(null, dockerState === 'running' ? 'container-id' : '')
        } else callback(new Error('no configuration file provided'), '')
        return {}
      }) as never)
      if (dockerState === 'empty') expect((await stopDevServer('w')).status).toBe('stopped')
      else await expect(stopDevServer('w')).rejects.toThrow('Dev server stop failed')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  },
)

it('retains ownership when the process group cannot be inspected', async () => {
  const proc = Object.assign(new EventEmitter(), {
    pid: 987654,
    exitCode: null,
    signalCode: null,
    stdout: null,
    stderr: null,
  })
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
  try {
    vi.mocked(getWorkspace).mockReturnValue(
      makeWorkspace({ id: 'inspection', projectPath: '/tmp', worktreePath: '/tmp' }),
    )
    vi.mocked(getProjectSettings).mockReturnValue(
      makeProjectSettings({ devServer: { startCommand: 'run', stopCommand: '' } }),
    )
    vi.mocked(spawn).mockReturnValue(proc as never)
    mockCommandFailure(new Error('process inspection failed'))
    startDevServer('inspection')
    await expect(stopDevServer('inspection')).rejects.toThrow('process inspection failed')
    expect(() => startDevServer('inspection')).toThrow('already starting')
  } finally {
    kill.mockRestore()
  }
})

it('preserves Docker services on shutdown and discovers them again after restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-preserve-dev-'))
  try {
    fs.mkdirSync(path.join(dir, '.container/instances'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, '.container/instances/foo.env'),
      'INSTANCE_NAME=foo\nPROJECT_NAME=foo\nHTTP_PORT=8710\n',
    )
    const workspace = makeWorkspace({ id: 'preserved', projectPath: dir, worktreePath: dir, workingBranch: 'foo' })
    vi.mocked(listWorkspaces).mockReturnValue([workspace])
    vi.mocked(getWorkspace).mockReturnValue(workspace)
    vi.mocked(getProjectSettings).mockReturnValue(
      makeProjectSettings({ devServer: { startCommand: 'docker compose up -d', stopCommand: 'custom-stop' } }),
    )
    mockCommandOutput('foo-web\tfoo\n')
    await stopAllDevServers({ preserveDocker: true })
    expect(execFile).not.toHaveBeenCalled()
    expect(emitEphemeral).not.toHaveBeenCalled()
    _resetTrackedProcessesForTests()
    expect(await getStatus(dir, 'foo', 'preserved')).toMatchObject({
      status: 'running',
      containers: ['foo-web'],
      url: 'http://localhost:8710',
    })
    vi.mocked(execFile).mockClear()
    await stopDevServer('preserved')
    expect(execFile).toHaveBeenCalledWith('bash', ['-c', 'custom-stop'], expect.anything(), expect.any(Function))
    expect(execFile).toHaveBeenCalledWith(
      'docker',
      ['compose', '-p', 'foo', 'down'],
      expect.anything(),
      expect.any(Function),
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

it('still terminates tracked local processes without stop scripts when preserving Docker', async () => {
  const workspace = makeWorkspace({ id: 'local', projectPath: '/tmp/no-instance', worktreePath: '/tmp/no-instance' })
  const proc = Object.assign(new EventEmitter(), {
    stdout: null,
    stderr: null,
    exitCode: null as number | null,
    signalCode: null,
    kill: vi.fn(),
  })
  vi.mocked(listWorkspaces).mockReturnValue([workspace])
  vi.mocked(getWorkspace).mockReturnValue(workspace)
  vi.mocked(getProjectSettings).mockReturnValue(
    makeProjectSettings({ devServer: { startCommand: 'npm run dev', stopCommand: 'custom-stop' } }),
  )
  vi.mocked(spawn).mockReturnValue(proc as never)
  startDevServer('local')
  const stopping = stopAllDevServers({ preserveDocker: true })
  expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
  proc.exitCode = 0
  proc.emit('exit', 0)
  await stopping
  expect(execFile).not.toHaveBeenCalled()
  vi.mocked(emitEphemeral).mockClear()
  proc.emit('error', new Error('late error'))
  proc.emit('exit', 1)
  await Promise.resolve()
  expect(emitEphemeral).not.toHaveBeenCalled()
})

describe('dev-server admission', () => {
  function setup() {
    const processes: Array<EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }> = []
    vi.mocked(listWorkspaces).mockReturnValue([])
    vi.mocked(getGlobalSettings).mockReturnValue({ serializeDevServerStarts: true, maxRunningDevServers: 0 } as never)
    vi.mocked(getWorkspace).mockImplementation((id) =>
      makeWorkspace({ id, projectPath: '/tmp/no-admission-config', workingBranch: id }),
    )
    vi.mocked(getProjectSettings).mockReturnValue(
      makeProjectSettings({ devServer: { startCommand: 'npm run dev', stopCommand: '' } }),
    )
    vi.mocked(spawn).mockImplementation(() => {
      const proc = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        exitCode: null,
        signalCode: null,
        kill: vi.fn(),
      })
      processes.push(proc)
      return proc as never
    })
    return processes
  }

  it('serializes boots FIFO, deduplicates queued requests, and releases boot on readiness', async () => {
    const processes = setup()
    expect(startDevServer('a').status).toBe('starting')
    expect(startDevServer('b').status).toBe('queued')
    expect(startDevServer('c').status).toBe('queued')
    expect(startDevServer('b').status).toBe('queued')
    expect((await getStatus('/tmp/no-admission-config', 'b', 'b')).status).toBe('queued')
    expect(spawn).toHaveBeenCalledTimes(1)
    processes[0]!.stdout.emit('data', Buffer.from('Local: http://localhost:5173/\n'))
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    expect(updateDevServerStatus).toHaveBeenCalledWith('b', 'starting')
    processes[1]!.stdout.emit('data', Buffer.from('Local: http://localhost:5174/\n'))
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(3))
  })

  it('counts running servers, retries settings changes, and cancels queued stops', async () => {
    const processes = setup()
    vi.mocked(getGlobalSettings).mockReturnValue({ serializeDevServerStarts: true, maxRunningDevServers: 1 } as never)
    startDevServer('a')
    startDevServer('b')
    startDevServer('c')
    processes[0]!.stdout.emit('data', Buffer.from('Local: http://localhost:5173/\n'))
    await Promise.resolve()
    expect(spawn).toHaveBeenCalledTimes(1)
    await stopDevServer('b')
    vi.mocked(getGlobalSettings).mockReturnValue({ serializeDevServerStarts: true, maxRunningDevServers: 2 } as never)
    resumeQueuedDevServers()
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    expect(updateDevServerStatus).toHaveBeenCalledWith('c', 'starting')
    expect(updateDevServerStatus).not.toHaveBeenCalledWith('b', 'starting')
  })

  it('releases capacity after confirmed process exit and never restarts on shutdown', async () => {
    const processes = setup()
    startDevServer('a')
    startDevServer('b')
    processes[0]!.emit('exit', 0)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    startDevServer('c')
    const { beginDevServerShutdown } = await import('../server/services/dev-server-service.js')
    beginDevServerShutdown()
    processes[1]!.emit('exit', 0)
    resumeQueuedDevServers()
    await Promise.resolve()
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('disabling serialization admits simultaneous boots and failed spawn releases capacity', async () => {
    const processes = setup()
    startDevServer('a')
    startDevServer('b')
    startDevServer('c')
    vi.mocked(getGlobalSettings).mockReturnValue({ serializeDevServerStarts: false, maxRunningDevServers: 0 } as never)
    resumeQueuedDevServers()
    await vi.waitFor(() => expect(processes).toHaveLength(3))
    vi.mocked(getGlobalSettings).mockReturnValue({ serializeDevServerStarts: true, maxRunningDevServers: 1 } as never)
    startDevServer('d')
    for (const proc of processes) proc.emit('error', new Error('spawn failed'))
    await vi.waitFor(() => expect(processes).toHaveLength(4))
  })

  it('cancels a queued launch when lifecycle ownership is acquired before admission', async () => {
    const processes = setup()
    startDevServer('a')
    startDevServer('b')
    const { withWorkspaceLifecycleGuard } = await import('../server/utils/workspace-lifecycle-guard.js')
    await withWorkspaceLifecycleGuard('b', async () => {
      processes[0]!.stdout.emit('data', Buffer.from('Local: http://localhost:5173/\n'))
      await vi.waitFor(() => expect(updateDevServerStatus).toHaveBeenCalledWith('b', 'error'))
    })
    resumeQueuedDevServers()
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('recovers Docker capacity before admission and releases boot only after the command exits', async () => {
    const processes = setup()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-admission-docker-'))
    try {
      fs.mkdirSync(path.join(dir, '.container/instances'), { recursive: true })
      fs.writeFileSync(
        path.join(dir, '.container/instances/foo.env'),
        'INSTANCE_NAME=foo\nPROJECT_NAME=foo\nHTTP_PORT=8710\n',
      )
      const dockerWorkspace = makeWorkspace({ id: 'docker', projectPath: dir, workingBranch: 'foo' })
      vi.mocked(listWorkspaces).mockReturnValue([dockerWorkspace])
      vi.mocked(getWorkspace).mockImplementation((id) =>
        id === 'docker'
          ? dockerWorkspace
          : makeWorkspace({ id, projectPath: '/tmp/no-admission-config', workingBranch: id }),
      )
      vi.mocked(getGlobalSettings).mockReturnValue({ serializeDevServerStarts: true, maxRunningDevServers: 1 } as never)
      mockCommandOutput('foo-web\tfoo\n')
      expect(startDevServer('a').status).toBe('queued')
      await vi.waitFor(() => expect(execFile).toHaveBeenCalled())
      await Promise.resolve()
      expect(spawn).not.toHaveBeenCalled()
      mockCommandFailure(new Error('daemon unavailable'))
      resumeQueuedDevServers()
      await Promise.resolve()
      expect(spawn).not.toHaveBeenCalled()
      mockCommandOutput('')
      resumeQueuedDevServers()
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
      processes[0]!.emit('exit', 0)
      await vi.waitFor(() => expect(updateDevServerStatus).toHaveBeenCalledWith('a', 'unknown'))
      startDevServer('docker')
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
      startDevServer('b')
      mockCommandOutput('foo-web\tfoo\n')
      expect((await getStatus(dir, 'foo', 'docker')).status).toBe('starting')
      expect(spawn).toHaveBeenCalledTimes(2)
      processes[1]!.emit('exit', 0)
      await vi.waitFor(() => expect(updateDevServerStatus).toHaveBeenCalledWith('docker', 'running'))
      expect(spawn).toHaveBeenCalledTimes(2)
      vi.mocked(getGlobalSettings).mockReturnValue({ serializeDevServerStarts: true, maxRunningDevServers: 0 } as never)
      resumeQueuedDevServers()
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(3))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('retains capacity after a failed stop and releases it only when retry succeeds', async () => {
    const processes = setup()
    vi.mocked(getGlobalSettings).mockReturnValue({ serializeDevServerStarts: true, maxRunningDevServers: 1 } as never)
    vi.mocked(getProjectSettings).mockReturnValue(
      makeProjectSettings({ devServer: { startCommand: 'run', stopCommand: 'stop' } }),
    )
    startDevServer('a')
    startDevServer('b')
    mockCommandFailure(new Error('stop failed'))
    const stopping = stopDevServer('a')
    processes[0]!.emit('exit', 0)
    await expect(stopping).rejects.toThrow('stop failed')
    resumeQueuedDevServers()
    await Promise.resolve()
    expect(spawn).toHaveBeenCalledTimes(1)
    mockCommandOutput('')
    await stopDevServer('a')
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
  })

  it.each([false, true])(
    'confirms queued Docker shutdown during suspended recovery (stop fails: %s)',
    async (fails) => {
      setup()
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-queued-stop-'))
      try {
        fs.mkdirSync(path.join(dir, '.container/instances'), { recursive: true })
        fs.writeFileSync(path.join(dir, '.container/instances/foo.env'), 'INSTANCE_NAME=foo\nPROJECT_NAME=foo\n')
        const workspace = makeWorkspace({ id: 'docker', projectPath: dir, workingBranch: 'foo' })
        vi.mocked(listWorkspaces).mockReturnValue([workspace])
        vi.mocked(getWorkspace).mockReturnValue(workspace)
        let finishInspection!: (err: Error | null, stdout: string) => void
        let finishStop!: (err: Error | null, stdout: string) => void
        vi.mocked(execFile).mockImplementation(((command: string, args: string[], ...rest: unknown[]) => {
          const callback = rest.at(-1) as (err: Error | null, stdout: string) => void
          if (command === 'docker' && args[0] === 'ps') finishInspection = callback
          else if (command === 'docker' && args[0] === 'compose') finishStop = callback
          return {}
        }) as never)
        expect(startDevServer('docker').status).toBe('queued')
        let settled = false
        const stopping = stopDevServer('docker')
        void stopping.then(
          () => {
            settled = true
          },
          () => {
            settled = true
          },
        )
        await Promise.resolve()
        expect(settled).toBe(false)
        expect(finishStop).toBeTypeOf('function')
        finishInspection(null, 'foo-web\tfoo\n')
        await Promise.resolve()
        expect(updateDevServerStatus).not.toHaveBeenCalledWith('docker', 'running')
        expect(updateDevServerStatus).not.toHaveBeenCalledWith('docker', 'stopped')
        finishStop(fails ? new Error('daemon unavailable') : null, '')
        if (fails) await expect(stopping).rejects.toThrow('daemon unavailable')
        else await expect(stopping).resolves.toMatchObject({ status: 'stopped' })
        expect(spawn).not.toHaveBeenCalled()
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  it('resumes waiting boots when a Docker status read confirms recovered readiness', async () => {
    const processes = setup()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-readiness-recovery-'))
    try {
      const workspace = makeWorkspace({ id: 'docker', projectPath: dir, workingBranch: 'foo' })
      vi.mocked(getWorkspace).mockImplementation((id) =>
        id === 'docker' ? workspace : makeWorkspace({ id, projectPath: '/tmp/no-admission-config', workingBranch: id }),
      )
      startDevServer('docker')
      // The script creates its instance configuration during startup.
      fs.mkdirSync(path.join(dir, '.container/instances'), { recursive: true })
      fs.writeFileSync(path.join(dir, '.container/instances/foo.env'), 'INSTANCE_NAME=foo\nPROJECT_NAME=foo\n')
      mockCommandFailure(new Error('daemon unavailable'))
      startDevServer('b')
      processes[0]!.emit('exit', 0)
      await vi.waitFor(() => expect(updateDevServerStatus).toHaveBeenCalledWith('docker', 'unknown'))
      expect(spawn).toHaveBeenCalledTimes(1)
      mockCommandOutput('foo-web\tfoo\n')
      expect((await getStatus(dir, 'foo', 'docker')).status).toBe('running')
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each([
    [false, 1],
    [true, 1],
    [false, 0],
    [true, 0],
  ] as const)(
    'keeps recovered Docker capacity until its first stop is confirmed (fails: %s, limit: %s)',
    async (fails, limit) => {
      setup()
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-recovered-stop-'))
      try {
        fs.mkdirSync(path.join(dir, '.container/instances'), { recursive: true })
        fs.writeFileSync(path.join(dir, '.container/instances/foo.env'), 'INSTANCE_NAME=foo\nPROJECT_NAME=foo\n')
        const workspace = makeWorkspace({
          id: 'docker',
          projectPath: dir,
          workingBranch: 'foo',
          devServerStatus: 'running',
        })
        vi.mocked(listWorkspaces).mockReturnValue([workspace])
        vi.mocked(getWorkspace).mockImplementation((id) =>
          id === 'docker'
            ? workspace
            : makeWorkspace({ id, projectPath: '/tmp/no-admission-config', workingBranch: id }),
        )
        vi.mocked(getGlobalSettings).mockReturnValue({
          serializeDevServerStarts: true,
          maxRunningDevServers: limit,
        } as never)
        let finishStop!: (err: Error | null, stdout: string) => void
        let running = true
        vi.mocked(execFile).mockImplementation(((command: string, args: string[], ...rest: unknown[]) => {
          const callback = rest.at(-1) as (err: Error | null, stdout: string) => void
          if (command === 'docker' && args[0] === 'compose') finishStop = callback
          else callback(null, running ? 'foo-web\tfoo\n' : '')
          return {}
        }) as never)
        const stopping = stopDevServer('docker')
        await Promise.resolve()
        expect(finishStop).toBeTypeOf('function')
        expect(startDevServer('other').status).toBe(limit ? 'queued' : 'starting')
        await new Promise((resolve) => setImmediate(resolve))
        expect(spawn).toHaveBeenCalledTimes(limit ? 0 : 1)
        running = fails
        finishStop(fails ? new Error('daemon unavailable') : null, '')
        if (fails) {
          await expect(stopping).rejects.toThrow('daemon unavailable')
          await new Promise((resolve) => setImmediate(resolve))
          expect(spawn).toHaveBeenCalledTimes(limit ? 0 : 1)
          const retry = stopDevServer('docker')
          await Promise.resolve()
          running = false
          finishStop(null, '')
          await retry
        } else await expect(stopping).resolves.toMatchObject({ status: 'stopped' })
        await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  it.each([false, true])(
    'ignores direct readiness during Docker boot (instance created by script: %s)',
    async (createdByScript) => {
      const processes = setup()
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-docker-readiness-'))
      try {
        const workspace = makeWorkspace({ id: 'docker', projectPath: dir, workingBranch: 'foo' })
        vi.mocked(listWorkspaces).mockReturnValue([workspace])
        vi.mocked(getWorkspace).mockImplementation((id) =>
          id === 'docker'
            ? workspace
            : makeWorkspace({ id, projectPath: '/tmp/no-admission-config', workingBranch: id }),
        )
        const createInstance = () => {
          fs.mkdirSync(path.join(dir, '.container/instances'), { recursive: true })
          fs.writeFileSync(
            path.join(dir, '.container/instances/foo.env'),
            'INSTANCE_NAME=foo\nPROJECT_NAME=foo\nHTTP_PORT=3000\n',
          )
        }
        if (!createdByScript) createInstance()
        mockCommandOutput('')
        startDevServer('docker')
        await vi.waitFor(() => expect(processes).toHaveLength(1))
        if (createdByScript) createInstance()
        expect(startDevServer('other').status).toBe('queued')
        processes[0]!.stdout.emit('data', Buffer.from('Local: http://localhost:3000/\n'))
        processes[0]!.stderr.emit('data', Buffer.from('App URL..... http://localhost:3000/\n'))
        let groupAlive = true
        Object.assign(processes[0]!, { pid: 987654 })
        vi.spyOn(process, 'kill').mockReturnValue(true)
        vi.mocked(execFile).mockImplementation(((command: string, _args: string[], ...rest: unknown[]) => {
          const callback = rest.at(-1) as (err: Error | null, stdout: string) => void
          callback(null, command === 'ps' ? (groupAlive ? '987654 S\n' : '') : 'foo-web\tfoo\n')
          return {}
        }) as never)
        await new Promise((resolve) => setImmediate(resolve))
        expect(processes).toHaveLength(1)
        expect((await getStatus(dir, 'foo', 'docker')).status).toBe('starting')
        processes[0]!.emit('exit', 0)
        await new Promise((resolve) => setImmediate(resolve))
        expect(processes).toHaveLength(1)
        expect((await getStatus(dir, 'foo', 'docker')).status).toBe('starting')
        groupAlive = false
        await vi.waitFor(() => expect(updateDevServerStatus).toHaveBeenCalledWith('docker', 'running'))
        await vi.waitFor(() => expect(processes).toHaveLength(2))
      } finally {
        vi.mocked(process.kill).mockRestore?.()
        fs.rmSync(dir, { recursive: true, force: true })
      }
    },
  )
})
