import type { AutoLoopRuntime } from '../../shared/auto-loop-types.js'
import { getDb } from '../db/index.js'
import { emitEphemeral } from './websocket-service.js'

export function getRuntime(workspaceId: string, ready = false): AutoLoopRuntime {
  const row = getDb()
    .prepare(`SELECT phase,state,reason,iteration,diagnostic_attempts,current_task_id,current_session_id
    FROM auto_loop_runs WHERE workspace_id=?`)
    .get(workspaceId) as AutoLoopRuntime | undefined
  return (
    row ?? {
      phase: ready ? 'execution' : 'grooming',
      state: 'waiting',
      reason: null,
      iteration: 0,
      diagnostic_attempts: 0,
      current_task_id: null,
      current_session_id: null,
    }
  )
}

export function setRuntime(workspaceId: string, patch: Partial<AutoLoopRuntime>): AutoLoopRuntime {
  const current = { ...getRuntime(workspaceId), ...patch }
  getDb()
    .prepare(`INSERT INTO auto_loop_runs
    (workspace_id,phase,state,reason,iteration,diagnostic_attempts,current_task_id,current_session_id,updated_at)
    VALUES (@id,@phase,@state,@reason,@iteration,@diagnostic_attempts,@current_task_id,@current_session_id,@now)
    ON CONFLICT(workspace_id) DO UPDATE SET phase=excluded.phase,state=excluded.state,reason=excluded.reason,
    iteration=excluded.iteration,diagnostic_attempts=excluded.diagnostic_attempts,current_task_id=excluded.current_task_id,
    current_session_id=excluded.current_session_id,updated_at=excluded.updated_at`)
    .run({ ...current, id: workspaceId, now: new Date().toISOString() })
  emitEphemeral(workspaceId, 'autoloop:state', current)
  return current
}
