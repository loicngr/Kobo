import { nanoid } from 'nanoid'
import { getDb } from '../db/index.js'
import { runScript, SCRIPT_TIMEOUT_MS } from '../utils/script-runner.js'
import { emit } from './websocket-service.js'

const SETUP_TIMEOUT_MS = SCRIPT_TIMEOUT_MS // 5 minutes

/** Environment variables passed to the setup script. */
export interface SetupScriptEnv {
  workspaceName: string
  branchName: string
  sourceBranch: string
  projectPath: string
}

const activeRuns = new Map<string, { runId: string; status: 'preparing' | 'running' }>()

/** Execute a setup script in a worktree, streaming output via WebSocket. Resolves with the exit code. */
export async function runSetupScript(
  workspaceId: string,
  worktreePath: string,
  script: string,
  env?: SetupScriptEnv,
  timeoutMs = SETUP_TIMEOUT_MS,
  beforeRun?: () => Promise<void>,
): Promise<{ exitCode: number }> {
  if (activeRuns.has(workspaceId)) throw new Error('Setup script is already running for this workspace')
  const runId = nanoid()
  const active = { runId, status: beforeRun ? ('preparing' as const) : ('running' as const) }
  activeRuns.set(workspaceId, active)
  try {
    emit(workspaceId, 'setup:run-started', { runId }, undefined, { requirePersistence: true })
    await beforeRun?.()
    active.status = 'running'
    const result = await runScript({
      workspaceId,
      worktreePath,
      script,
      eventPrefix: 'setup',
      tmpFileName: '.setup-script.tmp',
      env,
      timeoutMs,
    })
    emit(workspaceId, 'setup:run-finished', { runId, exitCode: result.exitCode })
    return result
  } catch (error) {
    emit(workspaceId, 'setup:run-finished', {
      runId,
      exitCode: null,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  } finally {
    activeRuns.delete(workspaceId)
  }
}

/** Read only the requested run and its bounded output; absence of a receipt is not success. */
export function getSetupScriptStatus(workspaceId: string, runId?: string, afterId?: string, limit = 50) {
  const db = getDb()
  const start = db
    .prepare(`SELECT rowid, id, payload, created_at FROM ws_events
    WHERE workspace_id = ? AND type = 'setup:run-started'
    AND (? IS NULL OR json_extract(payload, '$.runId') = ?)
    ORDER BY rowid DESC LIMIT 1`)
    .get(workspaceId, runId ?? null, runId ?? null) as
    | { rowid: number; id: string; payload: string; created_at: string }
    | undefined
  if (!start) {
    if (runId) throw new Error('Setup run not found or history expired')
    return { status: 'unknown', runId: null, logs: [], nextAfterId: null, hasMore: false }
  }
  const selectedRun = JSON.parse(start.payload).runId as string
  const next = db
    .prepare(
      "SELECT rowid FROM ws_events WHERE workspace_id = ? AND type = 'setup:run-started' AND rowid > ? ORDER BY rowid LIMIT 1",
    )
    .get(workspaceId, start.rowid) as { rowid: number } | undefined
  const end = next?.rowid ?? Number.MAX_SAFE_INTEGER
  const finish = db
    .prepare(`SELECT payload, created_at FROM ws_events WHERE workspace_id = ? AND type = 'setup:run-finished'
    AND rowid > ? AND rowid < ? AND json_extract(payload, '$.runId') = ? ORDER BY rowid DESC LIMIT 1`)
    .get(workspaceId, start.rowid, end, selectedRun) as { payload: string; created_at: string } | undefined
  let cursor = start.rowid
  if (afterId) {
    const event = db
      .prepare(
        "SELECT rowid FROM ws_events WHERE workspace_id = ? AND id = ? AND type = 'setup:output' AND rowid > ? AND rowid < ?",
      )
      .get(workspaceId, afterId, start.rowid, end) as { rowid: number } | undefined
    if (!event) throw new Error('Output cursor does not belong to this setup run or has expired')
    cursor = event.rowid
  }
  const rows = db
    .prepare(`SELECT id, created_at AS createdAt,
    substr(json_extract(payload, '$.text'), 1, 1000) AS text,
    length(json_extract(payload, '$.text')) > 1000 AS truncated
    FROM ws_events WHERE workspace_id = ? AND type = 'setup:output' AND rowid > ? AND rowid < ?
    ORDER BY rowid LIMIT ?`)
    .all(workspaceId, cursor, end, limit + 1) as Array<{
    id: string
    createdAt: string
    text: string
    truncated: number
  }>
  const logs = rows.slice(0, limit).map((row) => ({ ...row, truncated: Boolean(row.truncated) }))
  const outcome = finish ? (JSON.parse(finish.payload) as { exitCode: number | null; error?: string }) : null
  const exitCode = outcome?.exitCode ?? null
  const active = activeRuns.get(workspaceId)
  return {
    runId: selectedRun,
    status: finish
      ? exitCode === 0
        ? 'succeeded'
        : 'failed'
      : active?.runId === selectedRun
        ? active.status
        : 'unknown',
    exitCode,
    error: outcome?.error ?? null,
    startedAt: start.created_at,
    finishedAt: finish?.created_at ?? null,
    logs,
    hasMore: rows.length > limit,
    nextAfterId: logs.at(-1)?.id ?? afterId ?? null,
  }
}
