import type { AgentEngine, AgentEvent, EngineProcess, StartOptions } from './engines/types.js'

export class SessionController {
  private _engineProcess?: EngineProcess
  private _startPromise?: Promise<void>
  private _status: 'running' | 'stopping' = 'running'

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
    this._status = 'stopping'
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
    this.onEvent(ev)
  }
}
