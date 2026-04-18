import { getWorkspace, listTasks } from '../workspace-service.js'
import type { AgentEngine, AgentEvent, EngineProcess, StartOptions } from './engines/types.js'

export class SessionController {
  private engineProcess?: EngineProcess
  private _status: 'running' | 'stopping' = 'running'

  constructor(
    public readonly workspaceId: string,
    public readonly agentSessionId: string,
    private readonly engine: AgentEngine,
    private readonly onEvent: (ev: AgentEvent) => void,
  ) {}

  async start(options: StartOptions): Promise<void> {
    if (this.engineProcess) throw new Error('SessionController already started')
    this.engineProcess = await this.engine.start(options, (ev) => this.handle(ev))
    this._status = 'running'
  }

  sendMessage(content: string): void {
    if (!this.engineProcess) throw new Error('SessionController not started')
    this.engineProcess.sendMessage(content)
  }

  interrupt(): void {
    if (!this.engineProcess) throw new Error('SessionController not started')
    this.engineProcess.interrupt()
  }

  async stop(): Promise<void> {
    this._status = 'stopping'
    if (this.engineProcess) await this.engineProcess.stop()
  }

  get status(): 'running' | 'stopping' {
    return this._status
  }

  get pid(): number | undefined {
    return this.engineProcess?.pid
  }

  get engineSessionId(): string | undefined {
    return this.engineProcess?.engineSessionId
  }

  private handle(ev: AgentEvent): void {
    if (ev.kind === 'session:compacted') {
      try {
        this.injectPostCompactReminder()
      } catch (err) {
        console.error('[session-controller] post-compact reminder failed:', err)
      }
    }
    this.onEvent(ev)
  }

  private injectPostCompactReminder(): void {
    if (!this.engineProcess) return
    const ws = getWorkspace(this.workspaceId)
    const tasks = listTasks(this.workspaceId)
    const criteria = tasks.filter((t) => t.isAcceptanceCriterion)
    const todos = tasks.filter((t) => !t.isAcceptanceCriterion)
    if (criteria.length === 0 && todos.length === 0) return
    let reminder = `\n--- Context reminder after compaction ---\n`
    reminder += `Task: ${ws?.name ?? this.workspaceId}\n`
    if (todos.length > 0) {
      reminder += `\nTasks:\n${todos.map((t) => `- [${t.status === 'done' ? 'x' : ' '}] ${t.title}`).join('\n')}\n`
    }
    if (criteria.length > 0) {
      reminder += `\nAcceptance criteria:\n${criteria
        .map((t) => `- [${t.status === 'done' ? 'x' : ' '}] ${t.title}`)
        .join('\n')}\n`
      reminder += `\nWhen you complete a criterion, tell me which one so I can mark it as done.\n`
    }
    reminder += `--- End of reminder ---\n`
    this.engineProcess.sendMessage(reminder)
  }
}
