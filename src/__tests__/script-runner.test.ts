import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as wsService from '../server/services/websocket-service.js'
import {
  MAX_SCRIPT_OUTPUT_CHARS,
  MAX_SCRIPT_OUTPUT_LINE_CHARS,
  MAX_SCRIPT_OUTPUT_LINES,
  runScript,
} from '../server/utils/script-runner.js'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  // `script-runner.ts` now imports `git-ops.js`, which wires `execFileSync`/
  // `execFile` at module load time (`promisify(execFile)` throws immediately
  // if the arg isn't a function). These stubs just need to exist; the timeout
  // path calls `getIndexLockPath`, which swallows any error from them and
  // returns `null`, so an empty worktree path here is harmless.
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}))
vi.mock('../server/services/websocket-service.js', () => ({
  emit: vi.fn(),
  emitEphemeral: vi.fn(),
}))
vi.mock('../server/utils/safe-path.js', () => ({ ensureDirectoryInside: (root: string) => `${root}/.ai` }))
vi.mock('node:fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    mkdtempSync: vi.fn(() => '/tmp/wt/.ai/.script-test'),
    rmdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    existsSync: vi.fn(),
  },
  existsSync: vi.fn(),
}))

describe('runScript — process group on timeout', () => {
  afterEach(() => vi.restoreAllMocks())

  it('spawns bash detached and kills the whole process group on timeout', async () => {
    vi.useFakeTimers()
    const { EventEmitter } = await import('node:events')
    const fakeProc = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdout: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
      stderr: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
      kill: vi.fn(),
    })
    vi.mocked(spawn).mockReturnValue(fakeProc as never)
    // Killing the process group requires the global `process.kill(-pid, signal)`
    // form (ChildProcess#kill only ever signals the child itself). Stub it so
    // the test doesn't attempt a real syscall against a nonexistent pid group.
    const processKillSpy = vi.spyOn(process, 'kill').mockReturnValue(true)

    const promise = runScript({
      workspaceId: 'ws_1',
      worktreePath: '/tmp/wt',
      script: 'sleep 999 &',
      eventPrefix: 'setup',
      tmpFileName: '.setup-script.tmp',
      timeoutMs: 1_000,
    })

    // Confirm bash was spawned as a detached process-group leader.
    expect(spawn).toHaveBeenCalledWith('bash', expect.anything(), expect.objectContaining({ detached: true }))

    await vi.advanceTimersByTimeAsync(1_000)
    // Killing the group (-pid) reaches any backgrounded child, not just bash itself.
    expect(processKillSpy).toHaveBeenCalledWith(-4242, 'SIGKILL')

    fakeProc.emit('close', null)
    await promise
    vi.useRealTimers()
  })
})

describe('runScript — extra environment', () => {
  // `restoreAllMocks` restores spies but keeps a module mock's call history, so
  // without this the assertions below read the previous describe's spawn call.
  beforeEach(() => vi.mocked(spawn).mockClear())
  afterEach(() => vi.restoreAllMocks())

  it('exposes extraEnv to the script alongside the standard variables', async () => {
    const { EventEmitter } = await import('node:events')
    const fakeProc = Object.assign(new EventEmitter(), {
      pid: 99,
      stdout: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
      stderr: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
      kill: vi.fn(),
    })
    vi.mocked(spawn).mockReturnValue(fakeProc as never)

    const promise = runScript({
      workspaceId: 'ws_1',
      worktreePath: '/tmp/wt',
      script: 'true',
      eventPrefix: 'hook',
      tmpFileName: '.hook.tmp',
      env: {
        workspaceName: 'demo',
        branchName: 'feature/x',
        sourceBranch: 'develop',
        projectPath: '/tmp/project',
      },
      extraEnv: { KOBO_SESSION_END_REASON: 'watchdog' },
    })
    fakeProc.emit('close', 0)
    await promise

    const spawnEnv = vi.mocked(spawn).mock.calls[0]?.[2]?.env as Record<string, string>
    expect(spawnEnv.KOBO_SESSION_END_REASON).toBe('watchdog')
    // The standard variables must survive the merge, not be replaced by it.
    expect(spawnEnv.WORKSPACE_NAME).toBe('demo')
    expect(spawnEnv.BRANCH_NAME).toBe('feature/x')
  })

  it('only merges KOBO_-prefixed keys from extraEnv, so PATH or HOME cannot be replaced', async () => {
    const { EventEmitter } = await import('node:events')
    const fakeProc = Object.assign(new EventEmitter(), {
      pid: 101,
      stdout: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
      stderr: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
      kill: vi.fn(),
    })
    vi.mocked(spawn).mockReturnValue(fakeProc as never)

    const promise = runScript({
      workspaceId: 'ws_1',
      worktreePath: '/tmp/wt',
      script: 'true',
      eventPrefix: 'hook',
      tmpFileName: '.hook.tmp',
      extraEnv: { PATH: '/evil', KOBO_PR_NUMBER: '7' },
    })
    fakeProc.emit('close', 0)
    await promise

    const spawnEnv = vi.mocked(spawn).mock.calls[0]?.[2]?.env as Record<string, string>
    expect(spawnEnv.PATH).toBe(process.env.PATH)
    expect(spawnEnv.KOBO_PR_NUMBER).toBe('7')
  })

  it('never lets extraEnv overwrite the identity variables Kōbō controls', async () => {
    const { EventEmitter } = await import('node:events')
    const fakeProc = Object.assign(new EventEmitter(), {
      pid: 100,
      stdout: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
      stderr: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
      kill: vi.fn(),
    })
    vi.mocked(spawn).mockReturnValue(fakeProc as never)

    const promise = runScript({
      workspaceId: 'ws_real',
      worktreePath: '/tmp/wt',
      script: 'true',
      eventPrefix: 'hook',
      tmpFileName: '.hook.tmp',
      extraEnv: { WORKSPACE_ID: 'ws_spoofed' },
    })
    fakeProc.emit('close', 0)
    await promise

    const spawnEnv = vi.mocked(spawn).mock.calls[0]?.[2]?.env as Record<string, string>
    expect(spawnEnv.WORKSPACE_ID).toBe('ws_real')
  })
})

describe('runScript — output framing and bounds', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockClear()
    vi.mocked(wsService.emit).mockClear()
  })

  async function run(feed: (proc: { stdout: EventEmitter; stderr: EventEmitter }) => void): Promise<string[]> {
    const fakeProc = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdout: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
      stderr: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
      kill: vi.fn(),
    })
    vi.mocked(spawn).mockReturnValue(fakeProc as never)
    const promise = runScript({
      workspaceId: 'ws_1',
      worktreePath: '/tmp/wt',
      script: 'true',
      eventPrefix: 'setup',
      tmpFileName: '.setup-script.tmp',
    })
    feed(fakeProc)
    fakeProc.emit('close', 0)
    await promise
    return vi
      .mocked(wsService.emit)
      .mock.calls.filter(([, type]) => type === 'setup:output')
      .map(([, , payload]) => (payload as { text: string }).text)
  }

  it('reassembles lines and multi-byte characters split across chunks, per stream', async () => {
    const bytes = Buffer.from('première ligne ✓\nsecond')
    const cut = bytes.indexOf(Buffer.from('è')) + 1 // inside the two-byte "è"
    const lines = await run((proc) => {
      proc.stdout.emit('data', bytes.subarray(0, cut))
      proc.stderr.emit('data', Buffer.from('warn'))
      proc.stdout.emit('data', bytes.subarray(cut))
      proc.stderr.emit('data', Buffer.from('ing\n'))
      proc.stdout.emit('data', Buffer.from('e ligne'))
    })
    expect(lines).toEqual(['première ligne ✓', 'warning', 'seconde ligne'])
  })

  it('stops persisting output past the line cap and says so once', async () => {
    const lines = await run((proc) => {
      for (let i = 0; i < 3; i++) proc.stdout.emit('data', Buffer.from('line\n'.repeat(MAX_SCRIPT_OUTPUT_LINES)))
    })
    expect(lines).toHaveLength(MAX_SCRIPT_OUTPUT_LINES + 1)
    expect(lines.at(-1)).toMatch(/^\[kobo\] Output truncated/)
  })

  it('bounds a single endless line and the total persisted size', async () => {
    const lines = await run((proc) => {
      for (let i = 0; i < 40; i++) proc.stdout.emit('data', Buffer.from('x'.repeat(64 * 1024)))
    })
    expect(lines.at(-1)).toMatch(/^\[kobo\] Output truncated/)
    const persisted = lines.slice(0, -1)
    expect(Math.max(...persisted.map((line) => line.length))).toBeLessThanOrEqual(MAX_SCRIPT_OUTPUT_LINE_CHARS)
    expect(persisted.join('').length).toBeLessThanOrEqual(MAX_SCRIPT_OUTPUT_CHARS)
  })
})
