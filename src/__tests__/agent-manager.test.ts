import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mock child_process ──

const mockSpawn = vi.fn()
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}))

// ── Mock node:fs to avoid touching the real filesystem when writing .mcp.json ──

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    default: {
      ...actual,
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
      existsSync: vi.fn().mockReturnValue(false),
    },
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
  }
})

// ── Mock workspace-service ──

const mockUpdateWorkspaceStatus = vi.fn()
const mockGetWorkspace = vi.fn().mockReturnValue(null)
const mockListTasks = vi.fn().mockReturnValue([])
vi.mock('../server/services/workspace-service.js', () => ({
  updateWorkspaceStatus: (...args: unknown[]) => mockUpdateWorkspaceStatus(...args),
  getWorkspace: (...args: unknown[]) => mockGetWorkspace(...args),
  listTasks: (...args: unknown[]) => mockListTasks(...args),
}))

// ── Mock settings-service ──

vi.mock('../server/services/settings-service.js', () => ({
  getEffectiveSettings: vi.fn().mockReturnValue({
    model: 'auto',
    dangerouslySkipPermissions: true,
    prPromptTemplate: '',
    gitConventions: '',
    sourceBranch: 'main',
    devServer: null,
  }),
}))

// ── Mock websocket-service ──

const mockEmit = vi.fn().mockReturnValue('event-id')
vi.mock('../server/services/websocket-service.js', () => ({
  emit: (...args: unknown[]) => mockEmit(...args),
}))

// ── Mock process-tracker ──

const mockRegisterProcess = vi.fn()
const mockUnregisterProcess = vi.fn()
vi.mock('../server/utils/process-tracker.js', () => ({
  registerProcess: (...args: unknown[]) => mockRegisterProcess(...args),
  unregisterProcess: (...args: unknown[]) => mockUnregisterProcess(...args),
}))

// ── Mock db ──

const mockDbPrepare = vi.fn().mockReturnValue({
  run: vi.fn(),
  get: vi.fn(),
  all: vi.fn().mockReturnValue([]),
})
vi.mock('../server/db/index.js', () => ({
  getDb: () => ({ prepare: (...args: unknown[]) => mockDbPrepare(...args) }),
}))

// ── Helper: create a mock ChildProcess ──

function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable
    stderr: Readable
    stdin: Writable & { writable: boolean }
    killed: boolean
    kill: ReturnType<typeof vi.fn>
    pid: number
  }

  proc.stdout = new Readable({ read() {} })
  proc.stderr = new Readable({ read() {} })
  proc.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  }) as typeof proc.stdin
  proc.stdin.writable = true
  proc.killed = false
  proc.kill = vi.fn().mockImplementation(() => {
    proc.killed = true
  })
  proc.pid = 12345

  return proc
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(async () => {
  vi.useRealTimers()

  // Clean up agents map and all timers
  const { _getAgents, _getBackoffTimers, _getKillTimers, _getRetryCounts, _getSessionIds } = await import(
    '../server/services/agent-manager.js'
  )
  _getAgents().clear()
  for (const [, timer] of _getBackoffTimers()) {
    clearTimeout(timer)
  }
  _getBackoffTimers().clear()
  for (const [, timer] of _getKillTimers()) {
    clearTimeout(timer)
  }
  _getKillTimers().clear()
  _getRetryCounts().clear()
  _getSessionIds().clear()
})

describe('startAgent()', () => {
  it("lance un agent et l'enregistre dans la map", async () => {
    const mockProc = createMockProcess()
    mockSpawn.mockReturnValue(mockProc)

    const { startAgent, getAgentStatus, getRunningCount } = await import('../server/services/agent-manager.js')

    const agent = startAgent('ws-1', '/tmp/project', 'Do the thing')

    expect(agent.workspaceId).toBe('ws-1')
    expect(agent.status).toBe('running')
    expect(getAgentStatus('ws-1')).toBe('running')
    expect(getRunningCount()).toBe(1)

    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining([
        '--dangerously-skip-permissions',
        '--output-format',
        'stream-json',
        '--verbose',
        '-p',
        'Do the thing',
      ]),
      { cwd: '/tmp/project', stdio: ['pipe', 'pipe', 'pipe'] },
    )

    expect(mockRegisterProcess).toHaveBeenCalledWith('ws-1', mockProc)
  })

  it('leve une erreur si un agent est deja en cours pour ce workspace', async () => {
    const mockProc = createMockProcess()
    mockSpawn.mockReturnValue(mockProc)

    const { startAgent } = await import('../server/services/agent-manager.js')

    startAgent('ws-dup', '/tmp', 'prompt')

    expect(() => startAgent('ws-dup', '/tmp', 'prompt2')).toThrow(/already running/)
  })

  it('parse les lignes NDJSON de stdout et emet agent:output', async () => {
    const mockProc = createMockProcess()
    mockSpawn.mockReturnValue(mockProc)

    const { startAgent } = await import('../server/services/agent-manager.js')

    startAgent('ws-ndjson', '/tmp', 'prompt')

    // Simulate stdout line
    mockProc.stdout.push('{"type":"assistant","content":"hello"}\n')

    // Let readline process the line
    await vi.advanceTimersByTimeAsync(10)

    expect(mockEmit).toHaveBeenCalledWith(
      'ws-ndjson',
      'agent:output',
      {
        type: 'assistant',
        content: 'hello',
      },
      undefined,
    )
  })

  it('emet un raw line si le JSON est invalide', async () => {
    const mockProc = createMockProcess()
    mockSpawn.mockReturnValue(mockProc)

    const { startAgent } = await import('../server/services/agent-manager.js')

    startAgent('ws-raw', '/tmp', 'prompt')

    // Simulate invalid JSON
    mockProc.stdout.push('not valid json\n')

    await vi.advanceTimersByTimeAsync(10)

    expect(mockEmit).toHaveBeenCalledWith(
      'ws-raw',
      'agent:output',
      {
        type: 'raw',
        content: 'not valid json',
      },
      undefined,
    )
  })

  it('met a jour le status en completed sur exit code 0', async () => {
    const mockProc = createMockProcess()
    mockSpawn.mockReturnValue(mockProc)

    const { startAgent, _getAgents } = await import('../server/services/agent-manager.js')

    startAgent('ws-exit0', '/tmp', 'prompt')

    mockProc.emit('exit', 0)

    expect(mockUpdateWorkspaceStatus).toHaveBeenCalledWith('ws-exit0', 'completed')
    expect(mockUnregisterProcess).toHaveBeenCalledWith('ws-exit0')
    expect(_getAgents().has('ws-exit0')).toBe(false)
    expect(mockEmit).toHaveBeenCalledWith('ws-exit0', 'agent:status', { status: 'completed' }, undefined)
  })

  it('met a jour le status en error sur exit code non-zero', async () => {
    const mockProc = createMockProcess()
    mockSpawn.mockReturnValue(mockProc)

    const { startAgent } = await import('../server/services/agent-manager.js')

    startAgent('ws-exit1', '/tmp', 'prompt')

    mockProc.emit('exit', 1)

    expect(mockUpdateWorkspaceStatus).toHaveBeenCalledWith('ws-exit1', 'error')
    expect(mockEmit).toHaveBeenCalledWith('ws-exit1', 'agent:status', { status: 'error', exitCode: 1 }, undefined)
  })

  it('detecte les erreurs de quota dans stderr', async () => {
    const mockProc = createMockProcess()
    mockSpawn.mockReturnValue(mockProc)

    const { startAgent } = await import('../server/services/agent-manager.js')

    startAgent('ws-quota', '/tmp', 'prompt')

    // Simulate quota error on stderr
    mockProc.stderr.push(Buffer.from('Error: rate limit exceeded'))

    await vi.advanceTimersByTimeAsync(10)

    expect(mockUpdateWorkspaceStatus).toHaveBeenCalledWith('ws-quota', 'quota')
    expect(mockEmit).toHaveBeenCalledWith('ws-quota', 'agent:status', { status: 'quota' }, undefined)
  })
})

describe('stopAgent()', () => {
  it('envoie SIGTERM et met le status a stopping', async () => {
    const mockProc = createMockProcess()
    mockSpawn.mockReturnValue(mockProc)

    const { startAgent, stopAgent, _getAgents } = await import('../server/services/agent-manager.js')

    startAgent('ws-stop', '/tmp', 'prompt')

    stopAgent('ws-stop')

    expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM')

    // After the process exits, agent should clean up
    // (The exit handler won't emit error since status is 'stopping')
    mockProc.emit('exit', 0)
  })

  it('envoie SIGKILL apres 5s si le process ne repond pas', async () => {
    const mockProc = createMockProcess()
    mockProc.killed = false
    mockProc.kill = vi.fn() // Don't set killed to true on first call
    mockSpawn.mockReturnValue(mockProc)

    const { startAgent, stopAgent } = await import('../server/services/agent-manager.js')

    startAgent('ws-kill', '/tmp', 'prompt')
    stopAgent('ws-kill')

    expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM')

    // After 5s, SIGKILL should be sent
    vi.advanceTimersByTime(5000)

    expect(mockProc.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it("leve une erreur si aucun agent n'est en cours", async () => {
    const { stopAgent } = await import('../server/services/agent-manager.js')

    expect(() => stopAgent('ws-none')).toThrow(/No agent running/)
  })

  // C2: Guard against double-delete on race with natural exit
  it('le killTimer ne double-delete pas si le process a deja quitte naturellement (C2)', async () => {
    const mockProc = createMockProcess()
    mockProc.kill = vi.fn() // ne pas marquer killed sur SIGTERM
    mockSpawn.mockReturnValue(mockProc)

    const { startAgent, stopAgent, _getAgents } = await import('../server/services/agent-manager.js')

    startAgent('ws-c2', '/tmp', 'prompt')
    stopAgent('ws-c2')

    // Le process quitte naturellement avant les 5s (race condition)
    mockProc.emit('exit', 0)

    // A ce stade l'agent est sorti de la map
    expect(_getAgents().has('ws-c2')).toBe(false)

    // Le kill timer ne doit pas causer d'erreur ni interagir avec un agent fantome
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow()

    // SIGKILL ne doit PAS etre envoye car l'agent n'est plus dans la map
    expect(mockProc.kill).not.toHaveBeenCalledWith('SIGKILL')
  })

  // I3: readline doit etre ferme lors du stopAgent
  it("ferme l'interface readline lors du stopAgent (I3)", async () => {
    const mockProc = createMockProcess()
    mockSpawn.mockReturnValue(mockProc)

    const { startAgent, stopAgent } = await import('../server/services/agent-manager.js')

    const agent = startAgent('ws-rl-stop', '/tmp', 'prompt')
    const rlCloseSpy = vi.spyOn(agent.rl, 'close')

    stopAgent('ws-rl-stop')

    expect(rlCloseSpy).toHaveBeenCalled()
  })
})

describe('exit handler — nettoyage memoire (C1)', () => {
  it('supprime retryCounts a la sortie normale', async () => {
    const mockProc = createMockProcess()
    mockSpawn.mockReturnValue(mockProc)

    const { startAgent, _getRetryCounts } = await import('../server/services/agent-manager.js')

    startAgent('ws-c1-exit', '/tmp', 'prompt')

    // Simuler qu'il y avait un compteur de retry
    _getRetryCounts().set('ws-c1-exit', 3)

    mockProc.emit('exit', 0)

    expect(_getRetryCounts().has('ws-c1-exit')).toBe(false)
  })

  it('supprime retryCounts a la sortie en mode stopping', async () => {
    const mockProc = createMockProcess()
    mockSpawn.mockReturnValue(mockProc)

    const { startAgent, stopAgent, _getRetryCounts } = await import('../server/services/agent-manager.js')

    startAgent('ws-c1-stop', '/tmp', 'prompt')
    _getRetryCounts().set('ws-c1-stop', 2)

    stopAgent('ws-c1-stop')
    mockProc.emit('exit', 0)

    expect(_getRetryCounts().has('ws-c1-stop')).toBe(false)
  })

  // I3: readline doit etre ferme dans le exit handler
  it("ferme l'interface readline dans le exit handler (I3)", async () => {
    const mockProc = createMockProcess()
    mockSpawn.mockReturnValue(mockProc)

    const { startAgent } = await import('../server/services/agent-manager.js')

    const agent = startAgent('ws-rl-exit', '/tmp', 'prompt')
    const rlCloseSpy = vi.spyOn(agent.rl, 'close')

    mockProc.emit('exit', 0)

    expect(rlCloseSpy).toHaveBeenCalled()
  })
})

describe('stderr handler — guard stopping (I1)', () => {
  it("n'appelle pas handleQuota si l'agent est en status stopping (I1)", async () => {
    const mockProc = createMockProcess()
    mockSpawn.mockReturnValue(mockProc)

    const { startAgent, stopAgent } = await import('../server/services/agent-manager.js')

    startAgent('ws-i1', '/tmp', 'prompt')
    stopAgent('ws-i1')

    // Reset mock state
    mockUpdateWorkspaceStatus.mockClear()

    // Simulate quota error on stderr while stopping
    mockProc.stderr.push(Buffer.from('Error: rate limit exceeded'))
    await vi.advanceTimersByTimeAsync(10)

    // updateWorkspaceStatus avec 'quota' ne doit pas avoir ete appele
    expect(mockUpdateWorkspaceStatus).not.toHaveBeenCalledWith('ws-i1', 'quota')
  })
})

describe('sendMessage()', () => {
  it('ecrit dans le stdin du process', async () => {
    const mockProc = createMockProcess()
    const writtenData: string[] = []
    mockProc.stdin = new Writable({
      write(chunk, _encoding, callback) {
        writtenData.push(chunk.toString())
        callback()
      },
    }) as typeof mockProc.stdin
    mockProc.stdin.writable = true
    mockSpawn.mockReturnValue(mockProc)

    const { startAgent, sendMessage } = await import('../server/services/agent-manager.js')

    startAgent('ws-msg', '/tmp', 'prompt')
    sendMessage('ws-msg', 'hello agent')

    expect(writtenData).toContain('hello agent\n')
  })

  it("leve une erreur si aucun agent n'est en cours", async () => {
    const { sendMessage } = await import('../server/services/agent-manager.js')

    expect(() => sendMessage('ws-none', 'test')).toThrow(/No agent running/)
  })
})

describe('getAgentStatus()', () => {
  it("retourne null si aucun agent n'existe", async () => {
    const { getAgentStatus } = await import('../server/services/agent-manager.js')
    expect(getAgentStatus('nonexistent')).toBeNull()
  })
})

describe('getRunningCount()', () => {
  it("retourne 0 quand aucun agent n'est en cours", async () => {
    const { getRunningCount } = await import('../server/services/agent-manager.js')
    expect(getRunningCount()).toBe(0)
  })
})

// ── Gap 1: startAgent with resume=true ────────────────────────────────────────

describe('startAgent() — resume=true', () => {
  it('resume avec sessionIds map hit: utilise --resume <sessionId> -p <prompt>', async () => {
    const mockProc = createMockProcess()
    mockSpawn.mockReturnValue(mockProc)

    // Pre-set sessionIds map
    const { startAgent, _getSessionIds } = await import('../server/services/agent-manager.js')
    _getSessionIds().set('ws-resume-map', 'claude-session-from-map')

    // Mock DB to return a session row for the existing claude_session_id
    mockDbPrepare.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, claude_session_id FROM agent_sessions')) {
        return { run: vi.fn(), get: vi.fn().mockReturnValue(undefined), all: vi.fn().mockReturnValue([]) }
      }
      if (sql.includes('SELECT id FROM agent_sessions WHERE claude_session_id')) {
        return { run: vi.fn(), get: vi.fn().mockReturnValue(undefined), all: vi.fn().mockReturnValue([]) }
      }
      return { run: vi.fn(), get: vi.fn(), all: vi.fn().mockReturnValue([]) }
    })

    startAgent('ws-resume-map', '/tmp/project', 'Continue', undefined, true)

    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--resume', 'claude-session-from-map', '-p', 'Continue']),
      expect.any(Object),
    )
  })

  it('resume avec DB fallback: sessionIds vide mais DB a une session claude', async () => {
    const mockProc = createMockProcess()
    mockSpawn.mockReturnValue(mockProc)

    const { startAgent, _getSessionIds } = await import('../server/services/agent-manager.js')
    // sessionIds is empty (no entry for this workspace)
    expect(_getSessionIds().has('ws-resume-db')).toBe(false)

    // Mock DB: first query returns a session with claude_session_id
    mockDbPrepare.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, claude_session_id FROM agent_sessions')) {
        return {
          run: vi.fn(),
          get: vi.fn().mockReturnValue({ id: 'existing-session-id', claude_session_id: 'claude-from-db' }),
          all: vi.fn().mockReturnValue([]),
        }
      }
      return { run: vi.fn(), get: vi.fn(), all: vi.fn().mockReturnValue([]) }
    })

    startAgent('ws-resume-db', '/tmp/project', 'Continue DB', undefined, true)

    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--resume', 'claude-from-db', '-p', 'Continue DB']),
      expect.any(Object),
    )
  })

  it('resume sans aucune session: pas de --resume, juste -p <prompt>', async () => {
    const mockProc = createMockProcess()
    mockSpawn.mockReturnValue(mockProc)

    const { startAgent, _getSessionIds } = await import('../server/services/agent-manager.js')
    expect(_getSessionIds().has('ws-resume-none')).toBe(false)

    // Mock DB: no sessions at all
    mockDbPrepare.mockImplementation(() => {
      return { run: vi.fn(), get: vi.fn().mockReturnValue(undefined), all: vi.fn().mockReturnValue([]) }
    })

    startAgent('ws-resume-none', '/tmp/project', 'Fresh start', undefined, true)

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[]
    expect(spawnArgs).toContain('-p')
    expect(spawnArgs).toContain('Fresh start')
    expect(spawnArgs).not.toContain('--resume')
  })

  it('resume reutilise la session DB existante (UPDATE au lieu de INSERT)', async () => {
    const mockProc = createMockProcess()
    mockSpawn.mockReturnValue(mockProc)

    const mockRun = vi.fn()
    const { startAgent } = await import('../server/services/agent-manager.js')

    // Mock DB: return an existing session
    mockDbPrepare.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, claude_session_id FROM agent_sessions')) {
        return {
          run: mockRun,
          get: vi.fn().mockReturnValue({ id: 'reuse-session-id', claude_session_id: 'claude-reuse' }),
          all: vi.fn().mockReturnValue([]),
        }
      }
      if (sql.includes('UPDATE agent_sessions SET status')) {
        return { run: mockRun, get: vi.fn(), all: vi.fn().mockReturnValue([]) }
      }
      return { run: mockRun, get: vi.fn(), all: vi.fn().mockReturnValue([]) }
    })

    startAgent('ws-resume-reuse', '/tmp/project', 'Reuse session', undefined, true)

    // Verify UPDATE was called (not INSERT for sessions)
    const updateCalls = mockDbPrepare.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === 'string' && (call[0] as string).includes('UPDATE agent_sessions SET status'),
    )
    expect(updateCalls.length).toBeGreaterThanOrEqual(1)
  })
})

// ── Gap 2: session_id capture from NDJSON ─────────────────────────────────────

describe('startAgent() — session_id capture from NDJSON', () => {
  it('met a jour sessionIds et la DB quand un NDJSON contient session_id', async () => {
    const mockProc = createMockProcess()
    mockSpawn.mockReturnValue(mockProc)

    const mockRun = vi.fn()
    mockDbPrepare.mockReturnValue({
      run: mockRun,
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
    })

    const { startAgent, _getSessionIds } = await import('../server/services/agent-manager.js')

    startAgent('ws-session-cap', '/tmp', 'prompt')

    // Simulate NDJSON line with session_id (init message)
    mockProc.stdout.push('{"type":"system","subtype":"init","session_id":"test-session-123","slash_commands":[]}\n')

    await vi.advanceTimersByTimeAsync(10)

    // Verify sessionIds map was updated
    expect(_getSessionIds().get('ws-session-cap')).toBe('test-session-123')

    // Verify DB was updated with claude_session_id
    const updateCalls = mockDbPrepare.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === 'string' && (call[0] as string).includes('UPDATE agent_sessions SET claude_session_id'),
    )
    expect(updateCalls.length).toBeGreaterThanOrEqual(1)
  })
})

// ── Gap 4: handleQuota backoff ────────────────────────────────────────────────

describe('handleQuota — backoff behavior', () => {
  it('change le status en quota, emet agent:status et configure un backoff timer', async () => {
    const mockProc = createMockProcess()
    mockSpawn.mockReturnValue(mockProc)

    const { startAgent, _getBackoffTimers } = await import('../server/services/agent-manager.js')

    startAgent('ws-quota-full', '/tmp', 'prompt')

    // Simulate quota error on stderr
    mockProc.stderr.push(Buffer.from('Error: rate limit exceeded'))

    await vi.advanceTimersByTimeAsync(10)

    // Verify workspace status changed to quota
    expect(mockUpdateWorkspaceStatus).toHaveBeenCalledWith('ws-quota-full', 'quota')

    // Verify agent:status event was emitted with quota
    expect(mockEmit).toHaveBeenCalledWith('ws-quota-full', 'agent:status', { status: 'quota' }, undefined)

    // Verify backoff timer is set
    expect(_getBackoffTimers().has('ws-quota-full')).toBe(true)
  })
})

// ── Gap 6: BRAINSTORM_COMPLETE in parsed assistant messages ───────────────────

describe('startAgent() — BRAINSTORM_COMPLETE detection', () => {
  it('detecte BRAINSTORM_COMPLETE dans les messages assistant et passe en executing', async () => {
    const mockProc = createMockProcess()
    mockSpawn.mockReturnValue(mockProc)

    const { startAgent } = await import('../server/services/agent-manager.js')

    startAgent('ws-brainstorm', '/tmp', 'prompt')

    // Simulate a parsed assistant message with BRAINSTORM_COMPLETE
    const ndjsonLine = JSON.stringify({
      type: 'assistant',
      content: [{ type: 'text', text: 'Done [BRAINSTORM_COMPLETE]' }],
      session_id: 's1',
    })
    mockProc.stdout.push(`${ndjsonLine}\n`)

    await vi.advanceTimersByTimeAsync(10)

    // Verify updateWorkspaceStatus was called with 'executing'
    expect(mockUpdateWorkspaceStatus).toHaveBeenCalledWith('ws-brainstorm', 'executing')

    // Verify emit was called with agent:status executing
    expect(mockEmit).toHaveBeenCalledWith('ws-brainstorm', 'agent:status', { status: 'executing' }, 's1')
  })
})
