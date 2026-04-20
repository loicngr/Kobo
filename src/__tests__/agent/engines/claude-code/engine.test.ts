import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * We mock node:child_process.spawn to return a fake process with controllable
 * stdout / stderr streams and a mutable `pid`. Tests drive the streams and
 * observe the events the engine emits via the onEvent callback.
 */
vi.mock('node:child_process', () => {
  return {
    spawn: vi.fn(),
  }
})

function makeFakeProcess(pid = 42000): {
  proc: EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    stdin: { writable: boolean; write: (s: string) => boolean }
    pid: number
    kill: (sig?: NodeJS.Signals) => boolean
    killed: boolean
    exitCode: number | null
  }
  killed: string[]
  stdinWrites: string[]
} {
  const killed: string[] = []
  const stdinWrites: string[] = []
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: {
      writable: true,
      write(s: string) {
        stdinWrites.push(s)
        return true
      },
    },
    pid,
    killed: false,
    exitCode: null as number | null,
    kill(sig?: NodeJS.Signals) {
      killed.push(sig ?? 'SIGTERM')
      return true
    },
  })
  return { proc, killed, stdinWrites }
}

describe('createClaudeCodeEngine', () => {
  let spawnMock: ReturnType<typeof vi.fn>
  let cp: typeof import('node:child_process')

  beforeEach(async () => {
    vi.resetModules()
    cp = await import('node:child_process')
    spawnMock = cp.spawn as unknown as ReturnType<typeof vi.fn>
    spawnMock.mockReset()
  })

  afterEach(() => {
    spawnMock.mockReset()
  })

  it('spawns claude with the args produced by buildClaudeArgs and routes stdout lines to the parser', async () => {
    const fake = makeFakeProcess()
    spawnMock.mockReturnValue(fake.proc)
    const { createClaudeCodeEngine } = await import('../../../../server/services/agent/engines/claude-code/engine.js')
    const events: Array<{ kind: string }> = []
    const engine = createClaudeCodeEngine()
    const process = await engine.start(
      {
        workspaceId: 'w1',
        workingDir: '/tmp',
        prompt: 'hi',
        permissionMode: 'auto-accept',
        backendUrl: 'http://127.0.0.1:3000',
        koboHome: '/tmp/kobo',
        settings: {
          dangerouslySkipPermissions: true,
        } as unknown as import('../../../../server/services/settings-service.js').EffectiveSettings,
      },
      (ev) => events.push(ev),
    )

    expect(spawnMock).toHaveBeenCalledOnce()
    const [cmd, args] = spawnMock.mock.calls[0]
    expect(cmd).toBe('claude')
    expect(args).toContain('--output-format')
    expect(args).toContain('stream-json')
    expect(args).toContain('-p')
    // `hi` is embedded in the effective prompt alongside the MCP brief —
    // assert via substring match instead of exact equality.
    expect(args.some((a: string) => a.endsWith('hi'))).toBe(true)
    expect(process.pid).toBe(42000)

    // Drive the fake stdout
    fake.proc.stdout.write('{"type":"system","subtype":"init","session_id":"s1","model":"m","slash_commands":["x"]}\n')
    fake.proc.stdout.write('')
    // Let the readline 'line' handler fire
    await new Promise((r) => setImmediate(r))
    expect(events.some((e) => e.kind === 'session:started')).toBe(true)
    expect(events.some((e) => e.kind === 'skills:discovered')).toBe(true)
  })

  it('sendMessage writes to stdin with a trailing newline', async () => {
    const fake = makeFakeProcess()
    spawnMock.mockReturnValue(fake.proc)
    const { createClaudeCodeEngine } = await import('../../../../server/services/agent/engines/claude-code/engine.js')
    const engine = createClaudeCodeEngine()
    const process = await engine.start(
      {
        workspaceId: 'w1',
        workingDir: '/tmp',
        prompt: 'hi',
        permissionMode: 'auto-accept',
        backendUrl: 'http://127.0.0.1:3000',
        koboHome: '/tmp/kobo',
        settings: {
          dangerouslySkipPermissions: true,
        } as unknown as import('../../../../server/services/settings-service.js').EffectiveSettings,
      },
      () => {},
    )
    process.sendMessage('hello')
    expect(fake.stdinWrites).toEqual(['hello\n'])
  })

  it('interrupt sends SIGINT via process.kill', async () => {
    const fake = makeFakeProcess(54321)
    spawnMock.mockReturnValue(fake.proc)
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const { createClaudeCodeEngine } = await import('../../../../server/services/agent/engines/claude-code/engine.js')
    const engine = createClaudeCodeEngine()
    const p = await engine.start(
      {
        workspaceId: 'w1',
        workingDir: '/tmp',
        prompt: 'hi',
        permissionMode: 'auto-accept',
        backendUrl: 'http://127.0.0.1:3000',
        koboHome: '/tmp/kobo',
        settings: {
          dangerouslySkipPermissions: true,
        } as unknown as import('../../../../server/services/settings-service.js').EffectiveSettings,
      },
      () => {},
    )
    p.interrupt()
    expect(killSpy).toHaveBeenCalledWith(54321, 'SIGINT')
    killSpy.mockRestore()
  })

  it('stop sends SIGTERM and resolves on exit', async () => {
    const fake = makeFakeProcess()
    spawnMock.mockReturnValue(fake.proc)
    const { createClaudeCodeEngine } = await import('../../../../server/services/agent/engines/claude-code/engine.js')
    const p = await createClaudeCodeEngine().start(
      {
        workspaceId: 'w1',
        workingDir: '/tmp',
        prompt: 'hi',
        permissionMode: 'auto-accept',
        backendUrl: 'http://127.0.0.1:3000',
        koboHome: '/tmp/kobo',
        settings: {
          dangerouslySkipPermissions: true,
        } as unknown as import('../../../../server/services/settings-service.js').EffectiveSettings,
      },
      () => {},
    )
    const stopPromise = p.stop()
    expect(fake.killed).toContain('SIGTERM')
    // Simulate clean exit
    fake.proc.emit('exit', 0)
    await stopPromise
  })

  it('maps stderr "rate limit" into an error{category:quota} event', async () => {
    const fake = makeFakeProcess()
    spawnMock.mockReturnValue(fake.proc)
    const events: Array<{ kind: string; category?: string }> = []
    const { createClaudeCodeEngine } = await import('../../../../server/services/agent/engines/claude-code/engine.js')
    await createClaudeCodeEngine().start(
      {
        workspaceId: 'w1',
        workingDir: '/tmp',
        prompt: 'hi',
        permissionMode: 'auto-accept',
        backendUrl: 'http://127.0.0.1:3000',
        koboHome: '/tmp/kobo',
        settings: {
          dangerouslySkipPermissions: true,
        } as unknown as import('../../../../server/services/settings-service.js').EffectiveSettings,
      },
      (ev) => events.push(ev),
    )
    fake.proc.stderr.write(Buffer.from('Rate limit exceeded for this org\n'))
    await new Promise((r) => setImmediate(r))
    const quotaErr = events.find((e) => e.kind === 'error' && e.category === 'quota')
    expect(quotaErr).toBeDefined()
  })

  it('does not emit an error event for unrelated stderr output (line-buffered)', async () => {
    const fake = makeFakeProcess()
    spawnMock.mockReturnValue(fake.proc)
    const events: Array<{ kind: string; category?: string }> = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { createClaudeCodeEngine } = await import('../../../../server/services/agent/engines/claude-code/engine.js')
      await createClaudeCodeEngine().start(
        {
          workspaceId: 'w1',
          workingDir: '/tmp',
          prompt: 'hi',
          permissionMode: 'auto-accept',
          backendUrl: 'http://127.0.0.1:3000',
          koboHome: '/tmp/kobo',
          settings: {
            dangerouslySkipPermissions: true,
          } as unknown as import('../../../../server/services/settings-service.js').EffectiveSettings,
        },
        (ev) => events.push(ev),
      )
      // Noisy stderr that used to be flagged as an error{quota} because it
      // happened to contain the word "rate".
      fake.proc.stderr.write(Buffer.from('ui: switched to fast rate mode\n'))
      fake.proc.stderr.write(Buffer.from('info: retry in progress\n'))
      await new Promise((r) => setImmediate(r))
      expect(events.find((e) => e.kind === 'error')).toBeUndefined()
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('detects 429 rate limit responses as quota errors', async () => {
    const fake = makeFakeProcess()
    spawnMock.mockReturnValue(fake.proc)
    const events: Array<{ kind: string; category?: string }> = []
    const { createClaudeCodeEngine } = await import('../../../../server/services/agent/engines/claude-code/engine.js')
    await createClaudeCodeEngine().start(
      {
        workspaceId: 'w1',
        workingDir: '/tmp',
        prompt: 'hi',
        permissionMode: 'auto-accept',
        backendUrl: 'http://127.0.0.1:3000',
        koboHome: '/tmp/kobo',
        settings: {
          dangerouslySkipPermissions: true,
        } as unknown as import('../../../../server/services/settings-service.js').EffectiveSettings,
      },
      (ev) => events.push(ev),
    )
    fake.proc.stderr.write(Buffer.from('HTTP 429: rate limit reached\n'))
    await new Promise((r) => setImmediate(r))
    const quota = events.find((e) => e.kind === 'error' && e.category === 'quota')
    expect(quota).toBeDefined()
  })

  it('emits spawn_failed + session:ended when the child process emits an error event', async () => {
    const fake = makeFakeProcess()
    spawnMock.mockReturnValue(fake.proc)
    const events: Array<{ kind: string; category?: string; reason?: string; exitCode?: number | null }> = []
    const { createClaudeCodeEngine } = await import('../../../../server/services/agent/engines/claude-code/engine.js')
    await createClaudeCodeEngine().start(
      {
        workspaceId: 'w1',
        workingDir: '/tmp',
        prompt: 'hi',
        permissionMode: 'auto-accept',
        backendUrl: 'http://127.0.0.1:3000',
        koboHome: '/tmp/kobo',
        settings: {
          dangerouslySkipPermissions: true,
        } as unknown as import('../../../../server/services/settings-service.js').EffectiveSettings,
      },
      (ev) => events.push(ev),
    )
    // Simulate spawn failure (ENOENT when `claude` binary is missing).
    fake.proc.emit('error', new Error('ENOENT: spawn claude'))
    const spawnFailed = events.find((e) => e.kind === 'error' && e.category === 'spawn_failed')
    expect(spawnFailed).toBeDefined()
    expect(spawnFailed?.category).toBe('spawn_failed')
    const ended = events.find((e) => e.kind === 'session:ended')
    expect(ended).toBeDefined()
    expect(ended?.reason).toBe('error')
    expect(ended?.exitCode).toBeNull()
  })

  it('stop() resolves via the hard-timeout if no exit event ever fires', async () => {
    vi.useFakeTimers()
    try {
      const fake = makeFakeProcess()
      spawnMock.mockReturnValue(fake.proc)
      const { createClaudeCodeEngine } = await import('../../../../server/services/agent/engines/claude-code/engine.js')
      const p = await createClaudeCodeEngine().start(
        {
          workspaceId: 'w1',
          workingDir: '/tmp',
          prompt: 'hi',
          permissionMode: 'auto-accept',
          backendUrl: 'http://127.0.0.1:3000',
          koboHome: '/tmp/kobo',
          settings: {
            dangerouslySkipPermissions: true,
          } as unknown as import('../../../../server/services/settings-service.js').EffectiveSettings,
        },
        () => {},
      )
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      let resolved = false
      const stopPromise = p.stop().then(() => {
        resolved = true
      })
      // Without advancing timers nothing should have resolved yet
      await Promise.resolve()
      expect(resolved).toBe(false)
      // Advance past the 10s hard-timeout
      await vi.advanceTimersByTimeAsync(10_001)
      await stopPromise
      expect(resolved).toBe(true)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('hard-timeout'))
      warnSpy.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits session:ended with reason completed on exit code 0', async () => {
    const fake = makeFakeProcess()
    spawnMock.mockReturnValue(fake.proc)
    const events: Array<{ kind: string; reason?: string }> = []
    const { createClaudeCodeEngine } = await import('../../../../server/services/agent/engines/claude-code/engine.js')
    await createClaudeCodeEngine().start(
      {
        workspaceId: 'w1',
        workingDir: '/tmp',
        prompt: 'hi',
        permissionMode: 'auto-accept',
        backendUrl: 'http://127.0.0.1:3000',
        koboHome: '/tmp/kobo',
        settings: {
          dangerouslySkipPermissions: true,
        } as unknown as import('../../../../server/services/settings-service.js').EffectiveSettings,
      },
      (ev) => events.push(ev),
    )
    fake.proc.emit('exit', 0)
    const ended = events.find((e) => e.kind === 'session:ended')
    expect(ended?.reason).toBe('completed')
  })
})
