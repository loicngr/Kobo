export type AutoLoopPhase = 'grooming' | 'execution' | 'finalization'
export type AutoLoopState = 'active' | 'waiting' | 'blocked' | 'completed' | 'stopped'

export interface AutoLoopRuntime {
  phase: AutoLoopPhase
  state: AutoLoopState
  reason: string | null
  iteration: number
  diagnostic_attempts: number
  current_task_id: string | null
  current_session_id: string | null
}

export interface QueuedAutoLoopMessage {
  id: number
  clientMessageId: string
  content: string
  state: 'pending' | 'dispatching' | 'delivered' | 'unknown'
  sessionId: string | null
  createdAt: string
}
