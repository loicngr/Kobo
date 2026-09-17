import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { type ReviewConfiguration, reviewConfigurationChanged, type StartReviewRequest } from '../../shared/review.js'
import { assertAgentStopped } from '../utils/agent-stop-result.js'
import * as gitOps from '../utils/git-ops.js'
import { assertWorkspaceLifecycleAvailable } from '../utils/workspace-lifecycle-guard.js'
import { listEngines } from './agent/engines/registry.js'
import * as agentManager from './agent/orchestrator.js'
import { getReviewReturn, registerReviewReturn, restoreReviewConfiguration } from './review-return-service.js'
import { getActiveReviewTemplate, renderReviewTemplate } from './review-template-service.js'
import * as wsService from './websocket-service.js'
import * as workspaceService from './workspace-service.js'

const execFileAsync = promisify(execFile)
const launching = new Set<string>()

export class ReviewRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message)
  }
}

export function parseReviewRequest(input: unknown): StartReviewRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ReviewRequestError('Request body must be a JSON object', 400)
  const body = input as Record<string, unknown>
  for (const key of ['engine', 'model', 'reasoningEffort', 'agentPermissionMode', 'additionalInstructions']) {
    if (
      body[key] !== undefined &&
      (typeof body[key] !== 'string' || (key !== 'additionalInstructions' && !(body[key] as string).trim()))
    )
      throw new ReviewRequestError(
        `${key} must be a string${key === 'additionalInstructions' ? '' : ' and cannot be empty'}`,
        400,
      )
  }
  for (const key of ['newSession', 'returnToSession']) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean')
      throw new ReviewRequestError(`${key} must be a boolean`, 400)
  }
  return body as StartReviewRequest
}

function resolveConfiguration(workspace: ReviewConfiguration, body: StartReviewRequest): ReviewConfiguration {
  const engineId = body.engine ?? workspace.engine
  const engine = listEngines().find((e) => e.id === engineId)
  if (!engine) throw new ReviewRequestError(`Unknown engine '${engineId}'`, 400)
  const changedEngine = engineId !== workspace.engine
  const config: ReviewConfiguration = {
    engine: engineId,
    model: body.model ?? (changedEngine ? 'auto' : workspace.model),
    reasoningEffort: body.reasoningEffort ?? (changedEngine ? 'auto' : workspace.reasoningEffort),
    agentPermissionMode: body.agentPermissionMode ?? workspace.agentPermissionMode,
  }
  // Preserve an existing custom model when unchanged; reject incompatible selections.
  if (
    (changedEngine || config.model !== workspace.model) &&
    !engine.capabilities.models.some((m) => m.id === config.model)
  )
    throw new ReviewRequestError(`Model '${config.model}' is not supported by '${engineId}'`, 400)
  if (
    (changedEngine || config.reasoningEffort !== workspace.reasoningEffort) &&
    !engine.capabilities.effortLevels?.some((e) => e.id === config.reasoningEffort)
  )
    throw new ReviewRequestError(`Reasoning effort '${config.reasoningEffort}' is not supported by '${engineId}'`, 400)
  if (!engine.capabilities.permissionModes.includes(config.agentPermissionMode))
    throw new ReviewRequestError(
      `Permission mode '${config.agentPermissionMode}' is not supported by '${engineId}'`,
      400,
    )
  return config
}

function configure(id: string, config: ReviewConfiguration): void {
  workspaceService.updateWorkspaceEngineConfiguration(
    id,
    config.engine,
    config.model,
    config.reasoningEffort,
    config.agentPermissionMode,
  )
  wsService.emitEphemeral(id, 'workspace:configuration', config)
}

export async function startWorkspaceReview(id: string, input: unknown) {
  if (launching.has(id)) throw new ReviewRequestError('A review is already being started for this workspace', 409)
  launching.add(id)
  try {
    const workspace = workspaceService.getWorkspace(id)
    if (!workspace) throw new ReviewRequestError(`Workspace '${id}' not found`, 404)
    const body = parseReviewRequest(input)
    const configuration = resolveConfiguration(workspace, body)
    assertWorkspaceLifecycleAvailable(id)
    if (workspace.archivedAt || workspace.worktreePurgedAt)
      throw new ReviewRequestError('Restore the workspace before starting a review', 409)
    if (getReviewReturn(id))
      throw new ReviewRequestError('A review with an automatic return is already in progress', 409)
    const originalSession = workspaceService.getActiveSession(id)
    const changed = reviewConfigurationChanged(workspace, configuration)
    const differsFromSession =
      !!originalSession &&
      ((!!originalSession.engine && originalSession.engine !== configuration.engine) ||
        (configuration.model !== 'auto' && !!originalSession.model && originalSession.model !== configuration.model))
    const newSession = body.newSession === true || changed || differsFromSession || body.returnToSession === true
    if (
      body.returnToSession &&
      (!originalSession?.engineSessionId || (originalSession.engine && originalSession.engine !== workspace.engine))
    )
      throw new ReviewRequestError(
        'The current session cannot be resumed; start it before requesting an automatic return',
        400,
      )

    const worktreePath = workspace.worktreePath
    try {
      await execFileAsync('git', ['fetch', 'origin', workspace.sourceBranch], { cwd: worktreePath })
    } catch (err) {
      console.warn(`[start-review] git fetch failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    let baseCommit: string
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', `origin/${workspace.sourceBranch}`], {
        cwd: worktreePath,
      })
      baseCommit = stdout.trim()
    } catch (err) {
      throw new Error(
        `Cannot resolve base commit for branch ${workspace.sourceBranch}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    const commits = gitOps.getCommitsBetween(worktreePath, workspace.sourceBranch, workspace.workingBranch)
    const committedStats = gitOps.getDiffStatsBetween(worktreePath, workspace.sourceBranch, workspace.workingBranch)
    const workingTreeStats = gitOps.getWorkingTreeDiffStats(worktreePath)
    const diffStats = workingTreeStats.trim()
      ? `${committedStats}\n\n— Working tree (uncommitted) —\n${workingTreeStats}`
      : committedStats
    let rendered = renderReviewTemplate(getActiveReviewTemplate(), {
      workspace,
      commits,
      diffStats,
      baseCommit,
      additionalInstructions: (body.additionalInstructions ?? '').trim(),
    })
    if (body.returnToSession)
      rendered +=
        '\n\nFinish with a standalone summary of your review findings, including severity, file/line references, recommended fixes and any remaining uncertainty. This final message will be handed back to the original agent session. Do not rely on earlier messages to explain your findings.'

    assertWorkspaceLifecycleAvailable(id)
    const current = workspaceService.getWorkspace(id)
    if (!current || current.archivedAt || current.worktreePurgedAt || current.status === 'compacting')
      throw new ReviewRequestError('The workspace is no longer available for a review', 409)
    if (reviewConfigurationChanged(current, workspace))
      throw new ReviewRequestError('The workspace configuration changed; reopen the review dialog', 409)
    if (body.returnToSession && workspaceService.getActiveSession(id)?.id !== originalSession?.id)
      throw new ReviewRequestError('The current session changed; reopen the review dialog', 409)
    let emitSessionId: string
    if (newSession) {
      assertAgentStopped(await agentManager.stopAgentAndWait(id, undefined, 'replacement'))
      assertWorkspaceLifecycleAvailable(id)
      if (agentManager.getAgentStatus(id))
        throw new ReviewRequestError('Another agent has started in this workspace', 409)
      let pendingSessionId: string | undefined
      try {
        if (body.returnToSession && originalSession) {
          pendingSessionId = workspaceService.createIdleSession(id).id
          registerReviewReturn({
            workspaceId: id,
            reviewSessionId: pendingSessionId,
            originalSessionId: originalSession.id,
            original: {
              engine: workspace.engine,
              model: workspace.model,
              ...(originalSession.model ? { sessionModel: originalSession.model } : {}),
              reasoningEffort: workspace.reasoningEffort,
              agentPermissionMode: workspace.agentPermissionMode,
            },
            review: configuration,
          })
        }
        if (changed) configure(id, configuration)
        const agent = agentManager.startAgent(
          id,
          worktreePath,
          rendered,
          configuration.model,
          false,
          configuration.agentPermissionMode,
          pendingSessionId,
          configuration.reasoningEffort,
        )
        workspaceService.updateWorkspaceStatus(id, 'executing')
        emitSessionId = agent.agentSessionId
      } catch (err) {
        const restored = pendingSessionId ? restoreReviewConfiguration(id, pendingSessionId) : null
        if (changed && !restored) configure(id, workspace)
        throw new Error(`Failed to start review session: ${err instanceof Error ? err.message : String(err)}`)
      }
    } else {
      try {
        const delivery = await agentManager.sendMessageForFallback(id, rendered)
        if (delivery.status === 'sent') emitSessionId = delivery.sessionId
        else {
          const agent = agentManager.startAgent(
            id,
            worktreePath,
            rendered,
            workspace.model,
            true,
            workspace.agentPermissionMode,
            undefined,
            workspace.reasoningEffort,
          )
          workspaceService.updateWorkspaceStatus(id, 'executing')
          emitSessionId = agent.agentSessionId
        }
      } catch (err) {
        throw new Error(`Failed to dispatch review prompt: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    wsService.emit(id, 'user:message', { content: rendered, sender: 'user' }, emitSessionId)
    return { ok: true, messageSent: true, newSession }
  } finally {
    launching.delete(id)
  }
}
