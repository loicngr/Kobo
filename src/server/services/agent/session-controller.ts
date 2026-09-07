import type { AgentEngine, AgentEvent, EngineProcess, StartOptions } from './engines/types.js'

/** Why a controller was asked to stop; read by the session-ended hook. */
export type StopCause = 'user' | 'delete' | 'purge'

export class SessionController {
  /**
   * Set by the orchestrator when it stops this controller on purpose. A
   * delete or purge is about to remove the worktree, and a hook spawned in it
   * would run in a directory being deleted — the hook path checks this.
   */
  stopCause?: StopCause
  private _engineProcess?: EngineProcess
  private _startPromise?: Promise<void>
  private _status: 'running' | 'stopping' = 'running'
  /**
   * Set by `stop()`. Distinct from `_status` so the check in `startEngine` is
   * not narrowed away by the compiler: `stop()` can flip it while that method
   * is awaiting the engine.
   */
  private _stopRequested = false

  /**
   * Wall-clock creation time. The watchdog needs it: `engineProcess` stays
   * undefined until `engine.start` resolves, and without a grace window any
   * engine whose start becomes blocking would see every fresh session
   * declared dead on the first sweep.
   */
  readonly startedAt: number = Date.now()

  /**
   * Wall-clock time of the last event this controller relayed. Serialized to
   * the client so a stalled agent is visible as "last event 22 min ago"
   * instead of an indefinite "the agent is busy".
   */
  private _lastEventAt: number = Date.now()

  get lastEventAt(): number {
    return this._lastEventAt
  }

  get engineProcess(): EngineProcess | undefined {
    return this._engineProcess
  }

  constructor(
    public readonly workspaceId: string,
    public readonly agentSessionId: string,
    private readonly engine: AgentEngine,
    private readonly onEvent: (ev: AgentEvent) => void,
  ) {}

  async start(options: StartOptions): Promise<void> {
    if (this._startPromise) throw new Error('SessionController already started')
    this._startPromise = this.startEngine(options)
    await this._startPromise
  }

  private async startEngine(options: StartOptions): Promise<void> {
    // Already stopped before we got here. The orchestrator chains `start`
    // behind a zombie eviction that can take up to STOP_AGENT_TIMEOUT_MS, and a
    // stop landing in that window resolves immediately and reports "stopped" —
    // so the caller (delete, purge-worktree) is already removing the worktree.
    // Spawning into it and stopping afterwards, as the check below does, is too
    // late; the process must never exist.
    //
    // Still report an end: the orchestrator already created the session row,
    // and only session:ended closes it. Without this the row stayed `running`
    // until the next boot — blocking deleteSession and tagging the next
    // messages onto a ghost session.
    if (this._stopRequested) {
      this.handle({ kind: 'session:ended', reason: 'killed', exitCode: null })
      return
    }

    const process = await this.engine.start(options, (ev) => this.handle(ev))
    this._engineProcess = process
    if (this._status === 'stopping') {
      this._engineProcess = undefined
      await process.stop()
      return
    }
    this._status = 'running'
  }

  async sendMessage(content: string): Promise<void> {
    if (!this._startPromise) throw new Error('SessionController not started')
    await this._startPromise
    if (this._status === 'stopping') throw new Error('SessionController is stopping')
    if (!this._engineProcess) throw new Error('SessionController not started')
    await this._engineProcess.sendMessage(content)
  }

  interrupt(): void {
    if (!this._engineProcess) throw new Error('SessionController not started')
    this._engineProcess.interrupt()
  }

  async stop(): Promise<void> {
    this._stopRequested = true
    this._status = 'stopping'
    // `startEngine` may still be in flight: `_engineProcess` stays undefined
    // until `engine.start` resolves, so without this wait `stop()` would
    // resolve instantly while the engine keeps spinning up in the
    // background — the caller (e.g. worktree removal) would then race ahead
    // of a process that hasn't even started yet. `startEngine` itself
    // already stops the process it just got if it sees `_status ===
    // 'stopping'`, so waiting here is enough; a failed start must not fail
    // the stop, hence the swallowed rejection.
    if (this._startPromise) await this._startPromise.catch(() => {})
    if (this._engineProcess) await this._engineProcess.stop()
  }

  get status(): 'running' | 'stopping' {
    return this._status
  }

  get pid(): number | undefined {
    return this._engineProcess?.pid
  }

  get engineSessionId(): string | undefined {
    return this._engineProcess?.engineSessionId
  }

  private handle(ev: AgentEvent): void {
    this._lastEventAt = Date.now()
    this.onEvent(ev)
  }
}
