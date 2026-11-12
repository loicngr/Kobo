import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEngine, AgentEvent, EngineProcess } from '../../server/services/agent/engines/types.js'
import { DEFAULT_MEMORY_LIMITS } from '../../shared/memory-limits.js'
import { resetDb } from '../helpers/reset-db.js'

const emit = vi.hoisted(() => vi.fn())
vi.mock('../../server/services/websocket-service.js', () => ({ emit, emitEphemeral: vi.fn() }))
vi.mock('../../server/services/settings-service.js', () => ({
  getMemoryLimits: () => ({ ...DEFAULT_MEMORY_LIMITS }),
  getGlobalSettings: () => ({ autoLoopMaxRetries: 5 }),
  getEffectiveSettings: () => ({ model: 'auto', sourceBranch: 'develop', devServer: null, setupScript: '' }),
}))
vi.mock('../../server/services/usage/poller.js', () => ({ refreshNow: vi.fn().mockResolvedValue(null) }))

const parallelReviewRead = vi.hoisted(() => ({ fail: false }))
vi.mock('../../server/services/parallel-review-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/services/parallel-review-service.js')>()
  return {
    ...actual,
    getParallelReview: (workspaceId: string) => {
      if (parallelReviewRead.fail) throw new Error('parallel review row unreadable')
      return actual.getParallelReview(workspaceId)
    },
  }
})

type SessionRow = {
  id: string
  status: string
  started_at: string
  ended_at: string | null
  activation_order: number
  model: string | null
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20))

async function setup(process: (onEvent: (event: AgentEvent) => void) => Partial<EngineProcess> = () => ({})) {
  const { _registerEngineForTest } = await import('../../server/services/agent/engines/registry.js')
  const engine: AgentEngine = {
    id: 'claude-code',
    displayName: 'Claude Code',
    capabilities: {
      models: [],
      permissionModes: ['bypass'],
      supportsResume: true,
      supportsMcp: true,
      supportsLiveSteering: true,
      supportsReadOnly: true,
      supportsSkills: true,
      supportsSubagents: false,
      supportsQuotaStatus: false,
    },
    async start(_options, onEvent) {
      return {
        pid: 1,
        engineSessionId: 'native',
        sendMessage() {},
        interrupt() {},
        async stop() {},
        resolvePendingUserInput: () => false,
        ...process(onEvent),
      } as EngineProcess
    },
  }
  _registerEngineForTest(engine)
  const { createWorkspace } = await import('../../server/services/workspace-service.js')
  const { getDb } = await import('../../server/db/index.js')
  const orch = await import('../../server/services/agent/orchestrator.js')
  const ws = createWorkspace({ name: 'W', projectPath: '/tmp', sourceBranch: 'd', workingBranch: 'b' })
  const db = getDb()
  const sessions = () =>
    db
      .prepare(
        'SELECT id, status, started_at, ended_at, activation_order, model FROM agent_sessions WHERE workspace_id = ? ORDER BY rowid',
      )
      .all(ws.id) as SessionRow[]
  return { ws, db, orch, sessions }
}

describe('Orchestrator - launches that fail before the engine starts', () => {
  beforeEach(async () => {
    parallelReviewRead.fail = false
    emit.mockClear()
    vi.resetModules()
    vi.useRealTimers()
    await resetDb()
  })

  it('leaves no running session row when beforeDispatch refuses a fresh launch', async () => {
    const f = await setup()
    const refuse = () => {
      throw new Error('delivery mode changed')
    }

    expect(() =>
      f.orch.startAgent(f.ws.id, '/tmp', 'hi', undefined, false, undefined, undefined, undefined, refuse),
    ).toThrow('delivery mode changed')

    expect(f.sessions().filter((row) => row.status === 'running')).toEqual([])
    expect(f.sessions()).toMatchObject([{ status: 'error', activation_order: -1 }])
    expect(f.sessions()[0].ended_at).not.toBeNull()
    expect(f.orch.getRunningCount()).toBe(0)
  })

  it('restores a resumed session exactly when beforeDispatch refuses the launch', async () => {
    const f = await setup()
    f.db
      .prepare(
        `INSERT INTO agent_sessions (id, workspace_id, pid, status, engine, engine_session_id, model, started_at, ended_at, activation_order)
         VALUES ('previous', ?, NULL, 'completed', 'claude-code', 'native-previous', 'old-model', '2026-01-01', '2026-01-02', 4)`,
      )
      .run(f.ws.id)
    const before = f.sessions()

    expect(() =>
      f.orch.startAgent(f.ws.id, '/tmp', 'again', 'new-model', true, undefined, 'previous', undefined, () => {
        throw new Error('review return attempt is no longer active')
      }),
    ).toThrow('review return attempt is no longer active')

    expect(f.sessions()).toEqual(before)
  })

  it('restores every column of a reused session when a refused launch changed its role', async () => {
    const f = await setup()
    f.db
      .prepare(
        `INSERT INTO agent_sessions (id, workspace_id, pid, status, engine, engine_session_id, model, started_at, ended_at, end_reason, role, activation_order)
         VALUES ('previous', ?, 123, 'completed', 'claude-code', 'native-previous', 'old-model', '2026-01-01', '2026-01-02', 'completed', 'primary', 4)`,
      )
      .run(f.ws.id)
    const row = () => f.db.prepare("SELECT * FROM agent_sessions WHERE id = 'previous'").get()
    const before = row()
    let duringLaunch: unknown

    expect(() =>
      f.orch.startAgent(
        f.ws.id,
        '/tmp',
        'review',
        'new-model',
        false,
        undefined,
        'previous',
        undefined,
        () => {
          duringLaunch = row()
          throw new Error('review refused')
        },
        { parallelReview: { engine: 'claude-code' } },
      ),
    ).toThrow('review refused')

    // Guards the test itself: the launch really did rewrite the row.
    expect(duringLaunch).toMatchObject({ role: 'parallel-review', status: 'running', model: 'new-model' })
    expect(row()).toEqual(before)
    expect(before).toMatchObject({ role: 'primary', end_reason: 'completed', pid: 123 })
  })

  it('keeps the pending initial prompt and records no snapshot when the launch is refused', async () => {
    const f = await setup()
    f.db.prepare("UPDATE workspaces SET initial_prompt = 'mission' WHERE id = ?").run(f.ws.id)

    expect(() =>
      f.orch.startAgent(
        f.ws.id,
        '/tmp',
        'mission',
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        () => {
          throw new Error('delivery mode changed')
        },
        { persistInitialPrompt: true },
      ),
    ).toThrow('delivery mode changed')

    expect(f.db.prepare('SELECT initial_prompt FROM workspaces WHERE id = ?').get(f.ws.id)).toEqual({
      initial_prompt: 'mission',
    })
    expect(emit).not.toHaveBeenCalledWith(f.ws.id, 'user:message', expect.anything(), expect.anything())
    expect(emit).not.toHaveBeenCalledWith(
      f.ws.id,
      'user:message',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    )
  })

  it('does not close a session that was already running when another launch is refused', async () => {
    const f = await setup()
    const { agentSessionId } = f.orch.startAgent(f.ws.id, '/tmp', 'hi')
    await settle()

    expect(() => f.orch.startAgent(f.ws.id, '/tmp', 'again')).toThrow(/already running/)

    expect(f.sessions()).toMatchObject([{ id: agentSessionId, status: 'running' }])
  })

  it('closes the replacement session when the zombie it replaces cannot be stopped', async () => {
    const f = await setup(() => ({
      async stop() {
        throw new Error('zombie ignores stop')
      },
    }))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      f.orch.startAgent(f.ws.id, '/tmp', 'hi')
      await settle()
      f.db.prepare("UPDATE workspaces SET status = 'idle' WHERE id = ?").run(f.ws.id)

      const replacement = f.orch.startAgent(f.ws.id, '/tmp', 'again')
      await settle()

      expect(f.sessions().find((row) => row.id === replacement.agentSessionId)).toMatchObject({ status: 'error' })
    } finally {
      error.mockRestore()
      warn.mockRestore()
    }
  })

  it('releases the controller of a launch refused after it was registered', async () => {
    const f = await setup()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { agentSessionId } = f.orch.startAgent(f.ws.id, '/tmp', 'hi')
      // Archived between the synchronous launch and the deferred engine start.
      f.db.prepare("UPDATE workspaces SET archived_at = '2026-01-01' WHERE id = ?").run(f.ws.id)
      await settle()

      expect(f.sessions()).toMatchObject([{ id: agentSessionId, status: 'error' }])
      expect(f.orch.getRunningCount()).toBe(0)
    } finally {
      error.mockRestore()
    }
  })

  it('logs instead of rejecting when a background review return cannot read its state', async () => {
    const f = await setup()
    f.db
      .prepare(
        "INSERT INTO agent_sessions (id, workspace_id, status, started_at) VALUES ('review', ?, 'completed', 'now')",
      )
      .run(f.ws.id)
    f.db
      .prepare(
        `INSERT INTO parallel_reviews (workspace_id, review_session_id, original_session_id, original_configuration, return_to_session, phase, return_prompt)
         VALUES (?, 'review', 'source', '{}', 1, 'ready', 'report')`,
      )
      .run(f.ws.id)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      parallelReviewRead.fail = true
      f.orch.resumePendingParallelReviewReturns()
      await settle()

      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('[parallel-review]'),
        expect.objectContaining({ message: 'parallel review row unreadable' }),
      )
    } finally {
      error.mockRestore()
    }
  })

  it('reports a manual workspace whose engine never confirms closure, without releasing it', async () => {
    vi.useFakeTimers()
    try {
      let emitEvent: (event: AgentEvent) => void = () => {}
      const f = await setup((onEvent) => {
        emitEvent = onEvent
        return { closed: new Promise<void>(() => {}) }
      })
      const { agentSessionId } = f.orch.startAgent(f.ws.id, '/tmp', 'hi')
      await vi.advanceTimersByTimeAsync(0)
      emitEvent({ kind: 'session:ended', reason: 'completed', exitCode: 0 })
      emit.mockClear()

      await vi.advanceTimersByTimeAsync(f.orch.STOP_AGENT_TIMEOUT_MS)

      expect(emit).toHaveBeenCalledWith(
        f.ws.id,
        'agent:event',
        expect.objectContaining({ kind: 'error', code: 'engine_close_unconfirmed' }),
        agentSessionId,
      )
      expect(f.orch.getRunningCount()).toBe(1)
      expect(f.sessions()).toMatchObject([{ status: 'running' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the delivery failure in the turnover timeout of an engine that reported itself gone', async () => {
    vi.useFakeTimers()
    try {
      const f = await setup(() => ({
        async sendMessage() {
          throw new Error('Claude input stream is closed')
        },
      }))
      f.orch.startAgent(f.ws.id, '/tmp', 'hi')
      await vi.advanceTimersByTimeAsync(0)

      const delivery = f.orch.sendMessageForFallback(f.ws.id, 'follow up')
      const rejection = expect(delivery).rejects.toThrow(
        /Timed out waiting for agent controller turnover.*Claude input stream is closed/,
      )
      await vi.advanceTimersByTimeAsync(f.orch.FALLBACK_CONTROLLER_TURNOVER_TIMEOUT_MS + 50)

      await rejection
    } finally {
      vi.useRealTimers()
    }
  })
})
