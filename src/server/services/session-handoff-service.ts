import fs from 'node:fs'
import path from 'node:path'
import { nanoid } from 'nanoid'
import {
  HANDOFF_REPORT_MAX_CHARS,
  type HandoffConfiguration,
  type HandoffDecision,
  isHandoffPending,
  type SessionHandoff,
  type SessionHandoffRequest,
} from '../../shared/session-handoff.js'
import { getDb } from '../db/index.js'
import { assertAgentStopped } from '../utils/agent-stop-result.js'
import { ensureDirectoryInside } from '../utils/safe-path.js'
import { reserveWorkspaceLifecycle } from '../utils/workspace-lifecycle-guard.js'
import { listEngines } from './agent/engines/registry.js'
import * as agents from './agent/orchestrator.js'
import { buildEngineHandoff } from './engine-handoff-service.js'
import { getReviewReturn } from './review-return-service.js'
import { activateSession } from './session-activity-service.js'
import { registerHandoffStopHandler } from './session-handoff-runtime.js'
import { emit, emitEphemeral } from './websocket-service.js'
import * as workspaces from './workspace-service.js'

export class SessionHandoffError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 409,
  ) {
    super(message)
  }
}

interface HandoffRow {
  id: string
  workspace_id: string
  request_fingerprint: string
  source_session_id: string | null
  target_session_id: string | null
  source_configuration: string
  target_configuration: string
  source_model: string | null
  generate_summary: number
  state: SessionHandoff['state']
  report: string | null
  report_path: string | null
  generation_token: string | null
  error: string | null
  created_at: string
  updated_at: string
}
interface Runtime {
  id: string
  reservation: ReturnType<typeof reserveWorkspaceLifecycle>
  removeStopHandler: () => void
  cancelled: boolean
  pendingStops: number
  running: boolean
  generationError?: string
  timer?: ReturnType<typeof setTimeout>
}
const runtimes = new Map<string, Runtime>()
const GENERATION_TIMEOUT_MS = 5 * 60_000

function map(row: HandoffRow): SessionHandoff {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceSessionId: row.source_session_id,
    targetSessionId: row.target_session_id,
    source: JSON.parse(row.source_configuration),
    target: JSON.parse(row.target_configuration),
    generateSummary: !!row.generate_summary,
    state: row.state,
    reportPath: row.report_path,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
function read(id: string): HandoffRow {
  const row = getDb().prepare('SELECT * FROM session_handoffs WHERE id = ?').get(id) as HandoffRow | undefined
  if (!row) throw new SessionHandoffError('Session transfer not found', 404)
  return row
}
export function getCurrentSessionHandoff(workspaceId: string): SessionHandoff | null {
  const row = getDb()
    .prepare('SELECT * FROM session_handoffs WHERE workspace_id = ? ORDER BY rowid DESC LIMIT 1')
    .get(workspaceId) as HandoffRow | undefined
  return row ? map(row) : null
}
function publish(id: string): SessionHandoff {
  const handoff = map(read(id))
  emitEphemeral(handoff.workspaceId, 'workspace:handoff', { handoff })
  return handoff
}
function state(id: string, next: SessionHandoff['state'], error: string | null = null): SessionHandoff {
  getDb()
    .prepare('UPDATE session_handoffs SET state = ?, error = ?, updated_at = ? WHERE id = ?')
    .run(next, error, new Date().toISOString(), id)
  return publish(id)
}
function configure(workspaceId: string, configuration: HandoffConfiguration): void {
  workspaces.updateWorkspaceEngineConfiguration(
    workspaceId,
    configuration.engine,
    configuration.model,
    configuration.reasoningEffort ?? 'auto',
    configuration.agentPermissionMode,
  )
  emitEphemeral(workspaceId, 'workspace:configuration', {
    ...configuration,
    reasoningEffort: configuration.reasoningEffort ?? 'auto',
  })
}
function normalizeStoppedWorkspace(workspaceId: string): void {
  const workspace = workspaces.getWorkspace(workspaceId)
  if (
    !agents.hasController(workspaceId) &&
    workspace &&
    ['created', 'executing', 'brainstorming', 'extracting', 'awaiting-user', 'compacting'].includes(workspace.status)
  )
    workspaces.updateWorkspaceStatus(workspaceId, 'idle')
}
function restoreSource(row: HandoffRow): void {
  if (!agents.hasController(row.workspace_id) && row.source_session_id)
    activateSession(row.workspace_id, row.source_session_id)
  configure(row.workspace_id, map(row).source)
}
function clearTimer(runtime: Runtime): void {
  if (runtime.timer) clearTimeout(runtime.timer)
  runtime.timer = undefined
}
function release(workspaceId: string, runtime: Runtime): void {
  clearTimer(runtime)
  runtime.removeStopHandler()
  if (runtimes.get(workspaceId) === runtime) runtimes.delete(workspaceId)
  runtime.reservation.release()
}
function reserve(workspaceId: string, id: string): Runtime {
  const runtime: Runtime = {
    id,
    reservation: reserveWorkspaceLifecycle(workspaceId, 'session-handoff'),
    cancelled: false,
    pendingStops: 0,
    running: false,
    removeStopHandler: () => {},
  }
  runtimes.set(workspaceId, runtime)
  runtime.removeStopHandler = registerHandoffStopHandler(workspaceId, {
    shutdown() {
      runtime.cancelled = true
      clearTimer(runtime)
      getDb().prepare('UPDATE session_handoffs SET generation_token = NULL WHERE id = ?').run(id)
      restoreSource(read(id))
      state(id, 'interrupted', 'Kōbō stopped during this transfer. Inspect the sessions before retrying.')
    },
    requested() {
      runtime.pendingStops++
      runtime.cancelled = true
      clearTimer(runtime)
      getDb().prepare('UPDATE session_handoffs SET generation_token = NULL WHERE id = ?').run(id)
    },
    settled(outcome) {
      if (runtimes.get(workspaceId) !== runtime) return
      runtime.pendingStops--
      if (outcome !== 'stopped' && outcome !== 'not-running') {
        state(id, 'failed', 'Agent shutdown is not confirmed. Retry Stop before starting another session.')
        return
      }
      restoreSource(read(id))
      normalizeStoppedWorkspace(workspaceId)
      state(id, 'cancelled')
      release(workspaceId, runtime)
    },
  })
  return runtime
}
function fail(runtime: Runtime, error: unknown): void {
  if (runtime.cancelled || !isHandoffPending(map(read(runtime.id)))) return
  clearTimer(runtime)
  const row = read(runtime.id)
  getDb().prepare('UPDATE session_handoffs SET generation_token = NULL WHERE id = ?').run(row.id)
  restoreSource(row)
  normalizeStoppedWorkspace(row.workspace_id)
  state(row.id, 'failed', error instanceof Error ? error.message : String(error))
}

function parseRequest(input: unknown): SessionHandoffRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new SessionHandoffError('Invalid transfer request', 400)
  const body = input as Partial<SessionHandoffRequest>
  const target = body.target
  if (
    typeof body.requestId !== 'string' ||
    !body.requestId.trim() ||
    body.requestId.length > 128 ||
    (body.sourceSessionId !== null && typeof body.sourceSessionId !== 'string') ||
    typeof body.generateSummary !== 'boolean' ||
    !target ||
    typeof target !== 'object' ||
    typeof target.engine !== 'string' ||
    typeof target.model !== 'string' ||
    (target.reasoningEffort !== null && typeof target.reasoningEffort !== 'string') ||
    typeof target.agentPermissionMode !== 'string'
  )
    throw new SessionHandoffError('Invalid transfer request', 400)
  return {
    requestId: body.requestId,
    sourceSessionId: body.sourceSessionId,
    generateSummary: body.generateSummary,
    target: {
      engine: target.engine,
      model: target.model,
      reasoningEffort: target.reasoningEffort ?? 'auto',
      agentPermissionMode: target.agentPermissionMode,
    },
  }
}

export function createSessionHandoff(workspaceId: string, input: unknown, suppliedReport?: string): SessionHandoff {
  if (agents.isShuttingDown()) throw new SessionHandoffError('Kōbō is shutting down')
  const body = parseRequest(input)
  const fingerprint = JSON.stringify({ ...body, suppliedReport })
  const previous = getDb()
    .prepare('SELECT * FROM session_handoffs WHERE workspace_id = ? AND request_id = ?')
    .get(workspaceId, body.requestId) as HandoffRow | undefined
  if (previous) {
    if (previous.request_fingerprint !== fingerprint)
      throw new SessionHandoffError('This request id was already used for another transfer')
    return map(previous)
  }
  const workspace = workspaces.getWorkspace(workspaceId)
  if (!workspace) throw new SessionHandoffError('Workspace not found', 404)
  if (workspace.archivedAt || workspace.worktreePurgedAt)
    throw new SessionHandoffError('Restore the workspace before transferring its session')
  if (getReviewReturn(workspaceId))
    throw new SessionHandoffError('Finish or stop the review with automatic return first')
  if (isHandoffPending(getCurrentSessionHandoff(workspaceId)))
    throw new SessionHandoffError('A session transfer is already pending')
  const sourceSession = workspaces.getActiveSession(workspaceId)
  if ((sourceSession?.id ?? null) !== body.sourceSessionId)
    throw new SessionHandoffError('The current session changed. Reopen the transfer dialog.')
  const engine = listEngines().find((item) => item.id === body.target.engine)
  if (
    !engine?.capabilities.permissionModes.includes(body.target.agentPermissionMode) ||
    (!engine.capabilities.models.some((model) => model.id === body.target.model) &&
      !(workspace.engine === body.target.engine && workspace.model === body.target.model)) ||
    (body.target.reasoningEffort !== 'auto' &&
      !engine.capabilities.effortLevels?.some((effort) => effort.id === body.target.reasoningEffort))
  )
    throw new SessionHandoffError('The target engine configuration is not supported', 400)
  const id = nanoid()
  const runtime = reserve(workspaceId, id)
  try {
    const source: HandoffConfiguration = {
      engine: workspace.engine,
      model: workspace.model,
      reasoningEffort: workspace.reasoningEffort,
      agentPermissionMode: workspace.agentPermissionMode,
    }
    const now = new Date().toISOString()
    getDb()
      .prepare(`INSERT INTO session_handoffs
      (id, workspace_id, request_id, request_fingerprint, source_session_id, source_configuration, target_configuration, source_model, generate_summary, state, report, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopping', ?, ?, ?)`)
      .run(
        id,
        workspaceId,
        body.requestId,
        fingerprint,
        body.sourceSessionId,
        JSON.stringify(source),
        JSON.stringify(body.target),
        sourceSession?.model ?? workspace.model,
        body.generateSummary ? 1 : 0,
        suppliedReport?.slice(0, HANDOFF_REPORT_MAX_CHARS) ?? null,
        now,
        now,
      )
  } catch (error) {
    release(workspaceId, runtime)
    throw error
  }
  const result = publish(id)
  void run(runtime)
  return result
}

function generationPrompt(): string {
  return `The user has requested an immediate transfer to a fresh conversation. Your previous work has been interrupted. Your ONLY task now is to prepare a concise handoff for the next agent using the context of this exact conversation.
Do not modify the project, tasks, criteria, schedules, or settings. Do not continue implementation. Respect all existing user constraints and permissions.
Call kobo__submit_session_handoff with a Markdown report (at most ${HANDOFF_REPORT_MAX_CHARS} characters) covering:
1. Objective, user constraints, and remaining scope.
2. Decisions and their reasons; separate verified facts from assumptions.
3. Progress, relevant files, tasks, checks actually performed and their outcomes.
4. Failed approaches and mistakes to avoid repeating.
5. Open questions, uncertainties, and the concrete next action.
Do not claim checks you did not run. Reference source history where needed. After successful submission, end your turn immediately. The backend will start the fresh session; do not do that yourself.`
}

function buildPrompt(row: HandoffRow): string {
  const workspace = workspaces.getWorkspaceWithTasks(row.workspace_id)
  if (!workspace) throw new SessionHandoffError('Workspace not found', 404)
  const configurations = map(row)
  const mission = workspace.initialPrompt ?? workspace.description ?? workspace.name
  const tasks = JSON.stringify(
    workspace.tasks.map(({ id, title, status, role, verification, isAcceptanceCriterion }) => ({
      id,
      title,
      status,
      role,
      verification,
      isAcceptanceCriterion,
    })),
    null,
    2,
  )
  const run = getDb().prepare('SELECT * FROM auto_loop_runs WHERE workspace_id = ?').get(row.workspace_id)
  const messages = getDb()
    .prepare("SELECT id, state FROM auto_loop_messages WHERE workspace_id = ? AND state != 'delivered'")
    .all(row.workspace_id)
  return `# Kōbō session handoff\n\nContinue the current mission automatically in this fresh conversation. First verify the actual repository and Kōbō task state, then perform the next unfinished action. Preserve user constraints; this report is context, not authorization to override them. Agent-reported checks do not replace Kōbō verification requirements. Uncertain message deliveries require explicit acknowledgement; do not silently treat them as completed.\n\nSource session: ${row.source_session_id ?? 'none'}\nRead its history using kobo__read_workspace_events_csv with session_id=${row.source_session_id ?? '(no prior session)'}.\n\n## Initial mission\n${mission.slice(0, 32_000)}\n\n## Agent handoff\n${row.report ?? 'No LLM summary was generated. Recover missing decisions from the source conversation.'}\n\n## Current Kōbō tasks and reported evidence\n${tasks.slice(0, 48_000)}\n\n## Auto-loop and pending instructions\nThese are identifiers and statuses only. Do not execute or acknowledge queued instructions during this transfer. Kōbō will dispatch pending instructions separately; unknown deliveries require an explicit user decision.\nIntent: ${workspace.autoLoop}\n${JSON.stringify(run ?? null)}\n${JSON.stringify(messages).slice(0, 24_000)}\n\n${buildEngineHandoff(workspace, configurations.source.engine, configurations.target.engine, row.source_session_id)}`
}

function writeReport(row: HandoffRow, content: string): string {
  const workspace = workspaces.getWorkspace(row.workspace_id)!
  const directory = ensureDirectoryInside(workspace.worktreePath, '.ai/handoffs')
  // A local ignore file avoids modifying the project's tracked root .gitignore.
  const descriptor = fs.openSync(
    path.join(directory, '.gitignore'),
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW,
    0o600,
  )
  try {
    fs.writeFileSync(descriptor, '\n*\n')
  } finally {
    fs.closeSync(descriptor)
  }
  const relative = `.ai/handoffs/${row.id}-${nanoid(6)}.md`
  fs.writeFileSync(path.join(directory, path.basename(relative)), content, { flag: 'wx', mode: 0o600 })
  getDb().prepare('UPDATE session_handoffs SET report_path = ? WHERE id = ?').run(relative, row.id)
  return relative
}

async function run(runtime: Runtime): Promise<void> {
  if (runtime.running || runtime.cancelled) return
  runtime.running = true
  const row = read(runtime.id)
  try {
    state(row.id, 'stopping')
    assertAgentStopped(await agents.stopAgentAndWait(row.workspace_id, undefined, 'handoff'))
    if (runtime.cancelled) return
    normalizeStoppedWorkspace(row.workspace_id)
    const current = read(row.id)
    if (current.generate_summary && !current.report) {
      const session = workspaces.listSessions(row.workspace_id).find((item) => item.id === row.source_session_id)
      if (!session?.engineSessionId || (session.engine && session.engine !== map(row).source.engine))
        throw new SessionHandoffError('The source conversation cannot be resumed. Continue without an LLM summary.')
      const token = nanoid(40)
      getDb().prepare('UPDATE session_handoffs SET generation_token = ? WHERE id = ?').run(token, row.id)
      state(row.id, 'generating')
      runtime.generationError = undefined
      const source = map(row).source
      configure(row.workspace_id, source)
      const prompt = generationPrompt()
      workspaces.updateWorkspaceStatus(row.workspace_id, 'executing')
      agents.startAgent(
        row.workspace_id,
        workspaces.getWorkspace(row.workspace_id)!.worktreePath,
        prompt,
        row.source_model ?? source.model,
        true,
        source.agentPermissionMode,
        row.source_session_id!,
        source.reasoningEffort ?? 'auto',
        undefined,
        {
          lifecycleOwner: runtime.reservation.owner,
          handoffGeneration: true,
          mcpEnv: { KOBO_HANDOFF_ID: row.id, KOBO_HANDOFF_TOKEN: token },
          onError: (message) => {
            runtime.generationError = message
          },
          onEnded: (event) => {
            if (runtime.cancelled || read(row.id).state !== 'generating') return
            clearTimer(runtime)
            getDb().prepare('UPDATE session_handoffs SET generation_token = NULL WHERE id = ?').run(row.id)
            if (!read(row.id).report || event.reason === 'error' || (event.exitCode !== null && event.exitCode !== 0))
              fail(runtime, runtime.generationError ?? 'The source session ended without a valid handoff report.')
            else
              queueMicrotask(() => {
                void startTarget(runtime).catch((error) => fail(runtime, error))
              })
          },
        },
      )
      emit(row.workspace_id, 'user:message', { content: prompt, sender: 'system-prompt' }, row.source_session_id!)
      runtime.timer = setTimeout(() => {
        void agents.stopAgentAndWait(row.workspace_id, undefined, 'handoff').then((outcome) => {
          if (runtime.cancelled) return
          try {
            assertAgentStopped(outcome)
          } catch (error) {
            fail(runtime, error)
            return
          }
          if (read(row.id).report) void startTarget(runtime).catch((error) => fail(runtime, error))
          else fail(runtime, 'Handoff generation timed out. Retry or continue without an LLM summary.')
        })
      }, GENERATION_TIMEOUT_MS)
      runtime.timer.unref?.()
    } else await startTarget(runtime)
  } catch (error) {
    fail(runtime, error)
  } finally {
    runtime.running = false
  }
}

async function startTarget(runtime: Runtime): Promise<void> {
  if (runtime.cancelled) return
  const row = read(runtime.id)
  if (row.state === 'starting' || !isHandoffPending(map(row))) return
  // Both natural completion and deadline recovery converge here; only one may dispatch.
  assertAgentStopped(await agents.stopAgentAndWait(row.workspace_id, undefined, 'handoff'))
  if (runtime.cancelled || read(row.id).state === 'starting') return
  clearTimer(runtime)
  const prompt = buildPrompt(row)
  writeReport(row, prompt)
  configure(row.workspace_id, map(row).target)
  const session = workspaces.createIdleSession(row.workspace_id)
  getDb()
    .prepare('UPDATE session_handoffs SET target_session_id = ?, generation_token = NULL WHERE id = ?')
    .run(session.id, row.id)
  state(row.id, 'starting')
  let startError: string | undefined
  const completed = () => {
    if (runtime.cancelled || read(row.id).state !== 'starting') return
    if (startError) {
      fail(runtime, startError)
      return
    }
    state(row.id, 'completed')
    release(row.workspace_id, runtime)
  }
  workspaces.updateWorkspaceStatus(row.workspace_id, 'executing')
  agents.startAgent(
    row.workspace_id,
    workspaces.getWorkspace(row.workspace_id)!.worktreePath,
    prompt,
    map(row).target.model,
    false,
    map(row).target.agentPermissionMode,
    session.id,
    map(row).target.reasoningEffort ?? 'auto',
    undefined,
    {
      lifecycleOwner: runtime.reservation.owner,
      onStarted: completed,
      onError: (message) => {
        startError = message
      },
      onEnded: (event) => {
        if (event.reason === 'error' || event.exitCode)
          fail(runtime, startError ?? 'The target session failed to start.')
        else completed()
      },
    },
  )
  emit(
    row.workspace_id,
    'user:message',
    { content: prompt, sender: 'system-prompt', kind: 'engine-handoff' },
    session.id,
  )
}

export function submitSessionHandoff(
  workspaceId: string,
  id: string,
  token: unknown,
  report: unknown,
): { accepted: true } {
  const row = read(id)
  const runtime = runtimes.get(workspaceId)
  if (
    row.workspace_id !== workspaceId ||
    row.state !== 'generating' ||
    !runtime ||
    runtime.cancelled ||
    typeof token !== 'string' ||
    !token ||
    token !== row.generation_token
  )
    throw new SessionHandoffError('This handoff generation is no longer active')
  if (typeof report !== 'string' || !report.trim() || report.length > HANDOFF_REPORT_MAX_CHARS)
    throw new SessionHandoffError(
      `A non-empty Markdown report up to ${HANDOFF_REPORT_MAX_CHARS} characters is required`,
      400,
    )
  if (row.report && row.report !== report.trim())
    throw new SessionHandoffError('A different report was already submitted')
  getDb()
    .prepare('UPDATE session_handoffs SET report = ?, updated_at = ? WHERE id = ?')
    .run(report.trim(), new Date().toISOString(), id)
  return { accepted: true }
}

export async function decideSessionHandoff(
  workspaceId: string,
  id: string,
  action: HandoffDecision,
): Promise<SessionHandoff> {
  const row = read(id)
  if (row.workspace_id !== workspaceId) throw new SessionHandoffError('Session transfer not found', 404)
  if (!['retry', 'skip', 'cancel'].includes(action)) throw new SessionHandoffError('Invalid transfer decision', 400)
  if (!isHandoffPending(map(row))) return map(row)
  const runtime = runtimes.get(workspaceId) ?? reserve(workspaceId, id)
  if (action === 'cancel') {
    assertAgentStopped(await agents.stopAgentAndWait(workspaceId))
    return map(read(id))
  }
  if (runtime.pendingStops > 0) throw new SessionHandoffError('Cancellation is still waiting for the agent to stop')
  if (runtime.running || !['failed', 'interrupted'].includes(row.state))
    throw new SessionHandoffError('The transfer is still running')
  runtime.cancelled = false
  if (action === 'skip')
    getDb().prepare('UPDATE session_handoffs SET generate_summary = 0, report = NULL WHERE id = ?').run(id)
  void run(runtime)
  return map(read(id))
}

/** A restart never replays a possibly accepted native turn. Keep automation reserved until a decision. */
export function reconcileSessionHandoffs(): void {
  const rows = getDb()
    .prepare("SELECT * FROM session_handoffs WHERE state NOT IN ('completed', 'cancelled')")
    .all() as HandoffRow[]
  for (const row of rows) {
    getDb().prepare('UPDATE session_handoffs SET generation_token = NULL WHERE id = ?').run(row.id)
    restoreSource(row)
    state(
      row.id,
      'interrupted',
      'Kōbō restarted during this transfer. Delivery may be uncertain; inspect the sessions before retrying.',
    )
    if (!runtimes.has(row.workspace_id)) reserve(row.workspace_id, row.id)
  }
}

/** Legacy synchronous engine-switch clients still receive a target session id. */
export async function waitForSessionHandoff(id: string): Promise<SessionHandoff> {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const result = map(read(id))
    if (result.state === 'completed') return result
    if (['failed', 'interrupted', 'cancelled'].includes(result.state))
      throw new SessionHandoffError(result.error ?? 'Session transfer cancelled')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new SessionHandoffError('Transfer is still pending. Consult the current session transfer before retrying.')
}
