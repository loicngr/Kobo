import { checkoutDecisionError, deriveSteps } from '../../shared/pr-checkout-steps.js'
import { validateWorkspaceCreationArguments } from '../../shared/workspace-creation-tools.js'
import { CLAUDE_CODE_CAPABILITIES } from './agent/engines/claude-code/capabilities.js'
import { CODEX_CAPABILITIES } from './agent/engines/codex/capabilities.js'
import { rollbackCreatedPrCheckout } from './pr-checkout-rollback-service.js'
import type { PrCheckoutDecisions, PrCheckoutReport, ResolvePrCheckoutResult } from './pr-checkout-service.js'

type Dispatch = (path: string, init: RequestInit) => Promise<Response>
interface Diagnosis {
  report: PrCheckoutReport
  fingerprint: string
  pr: { number: number; url: string; headBranch: string; baseBranch: string } | null
}

export class WorkspaceCreationMcpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly stage: string,
    readonly details: unknown = null,
  ) {
    super(message)
    this.name = 'WorkspaceCreationMcpError'
  }
}

async function request<T>(
  dispatch: Dispatch,
  path: string,
  stage: string,
  body?: unknown,
  init?: RequestInit,
): Promise<T> {
  const response = await dispatch(
    path,
    init ?? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) },
  )
  const payload = await response.json().catch(() => null)
  if (!response.ok)
    throw new WorkspaceCreationMcpError(
      payload?.error ?? `Workspace request failed (${response.status})`,
      response.status,
      stage,
      payload,
    )
  return payload as T
}
function prIdentity(raw: string): { number: number; identity: string } {
  const url = new URL(raw)
  const pathname = url.pathname.replace(/\/+$/, '')
  const last = pathname.split('/').at(-1)!
  const number = Number(last)
  if (!/^[1-9]\d*$/.test(last) || !Number.isSafeInteger(number))
    throw new WorkspaceCreationMcpError('pr_url must end with a PR/MR number', 400, 'validate')
  return { number, identity: `${url.origin}${pathname}` }
}
function mapInput(input: Record<string, unknown>): Record<string, unknown> {
  const mapping: Record<string, string> = {
    name: 'name',
    project_path: 'projectPath',
    source_branch: 'sourceBranch',
    working_branch: 'workingBranch',
    model: 'model',
    reasoning_effort: 'reasoningEffort',
    brainstorm_model: 'brainstormModel',
    brainstorm_reasoning_effort: 'brainstormReasoningEffort',
    engine: 'engine',
    description: 'description',
    tags: 'tags',
    tasks: 'tasks',
    acceptance_criteria: 'acceptanceCriteria',
    agent_permission_mode: 'agentPermissionMode',
    auto_loop: 'autoLoop',
    auto_loop_session_mode: 'autoLoopSessionMode',
    skip_setup_script: 'skipSetupScript',
    workflow_policy: 'workflowPolicy',
    notion_url: 'notionUrl',
    notion_page_id: 'notionPageId',
    sentry_url: 'sentryUrl',
    pr_url: 'prUrl',
    worktree_path: 'worktreePath',
    comparison_id: 'comparisonId',
    creation_id: 'creationId',
  }
  const body: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(mapping)) if (Object.hasOwn(input, key)) body[field] = input[key]
  if (input.auto_loop_final_review !== undefined) {
    const config = input.auto_loop_final_review as Record<string, unknown> | null
    body.autoLoopFinalReview =
      config === null
        ? null
        : {
            engine: config.engine,
            model: config.model,
            reasoningEffort: config.reasoning_effort,
            additionalInstructions: config.additional_instructions ?? '',
          }
  }
  return body
}

/** Reuses the application's route validation, lifecycle guards, Git locks and rollback. */
export async function executeWorkspaceCreationTool(name: string, raw: unknown, dispatch: Dispatch): Promise<unknown> {
  let input: Record<string, unknown>
  try {
    input = validateWorkspaceCreationArguments(name, raw)
  } catch (error) {
    throw new WorkspaceCreationMcpError(error instanceof Error ? error.message : 'Invalid arguments', 400, 'validate')
  }
  const config = input.auto_loop_final_review as Record<string, unknown> | undefined | null
  if (config) {
    const capabilities = config.engine === 'codex' ? CODEX_CAPABILITIES : CLAUDE_CODE_CAPABILITIES
    if (!capabilities.effortLevels?.some((effort) => effort.id === config.reasoning_effort))
      throw new WorkspaceCreationMcpError('Unsupported review reasoning effort', 400, 'validate')
  }
  const body = mapInput(input)
  let resolvedCheckout: ResolvePrCheckoutResult | undefined
  if (input.pr_url) {
    const supplied = prIdentity(input.pr_url as string)
    const diagnosis = await request<Diagnosis>(dispatch, '/api/pull-requests/diagnose', 'diagnose', {
      projectPath: input.project_path,
      prNumber: supplied.number,
    })
    const requiresAction = (reason?: string) => ({
      created: false,
      requiresAction: true,
      ...diagnosis,
      ...(reason ? { reason } : {}),
    })
    if (diagnosis.pr && prIdentity(diagnosis.pr.url).identity !== supplied.identity)
      throw new WorkspaceCreationMcpError('pr_url does not belong to the selected project', 400, 'diagnose', diagnosis)
    if (name === 'diagnose_workspace_pr') return diagnosis
    if (!diagnosis.pr) return requiresAction('Pull request unavailable')
    const { report, pr, fingerprint } = diagnosis
    const plan = input.pr_checkout as { fingerprint: string; decisions: PrCheckoutDecisions } | undefined
    if (plan && plan.fingerprint !== fingerprint)
      throw new WorkspaceCreationMcpError(
        'The repository changed since the diagnosis was taken',
        409,
        'diagnose',
        diagnosis,
      )
    const decisions = plan?.decisions ?? {}
    if (report.workspace.state === 'active' && decisions.existingWorkspace === 'open')
      return { created: false, workspaceId: report.workspace.id, workspace: report.workspace }
    if (report.workspace.state === 'archived' && decisions.archivedWorkspace === 'unarchive') {
      const workspace = await request(
        dispatch,
        `/api/workspaces/${encodeURIComponent(report.workspace.id)}/unarchive`,
        'unarchive',
      )
      return { created: false, workspaceId: report.workspace.id, workspace }
    }
    // A purge or an existing association must never fall through to a second creation.
    if (report.workspace.state !== 'none')
      return requiresAction('Use the existing workspace; automatic duplicate creation is not supported')
    if (decisions.ongoingOperation === 'cancel') return { created: false, cancelled: true, ...diagnosis }
    const error = checkoutDecisionError(report, decisions)
    if (error) throw new WorkspaceCreationMcpError(error, 400, 'validate-checkout', diagnosis)
    const steps = deriveSteps(report)
    if (steps.some((step) => step.blocking)) return requiresAction('Checkout is blocked')
    if (!plan && (steps.length > 0 || report.worktree.state !== 'none')) return requiresAction()
    if (plan) {
      // Every state requiring a choice needs an explicit decision. In particular,
      // do not inherit the UI's defaults for reset/stash/abort or path selection.
      const missing = steps.some(
        (step) =>
          (step.id === 'path' && !decisions.pathCollision) ||
          (step.id === 'worktree' && !decisions.orphanWorktree) ||
          (step.id === 'operation' && !decisions.ongoingOperation) ||
          (step.id === 'changes' && !decisions.localChanges) ||
          (step.id === 'divergence' && !decisions.divergence),
      )
      if (missing) return requiresAction('Explicit checkout decisions are required')
    }
    body.sourceBranch = pr.baseBranch
    body.workingBranch = pr.headBranch
    body.prUrl = pr.url
    body.skipSetupScript = input.skip_setup_script ?? true
    if (input.worktree_path) {
      const diagnosedPath = 'path' in report.worktree ? report.worktree.path : null
      if (diagnosedPath !== input.worktree_path)
        throw new WorkspaceCreationMcpError(
          'worktree_path does not match the diagnosed PR checkout',
          400,
          'validate-checkout',
          diagnosis,
        )
    }
    const resolved = await request<ResolvePrCheckoutResult>(dispatch, '/api/pull-requests/resolve', 'resolve', {
      projectPath: input.project_path,
      prNumber: pr.number,
      headBranch: pr.headBranch,
      baseBranch: pr.baseBranch,
      decisions,
      fingerprint,
    })
    body.worktreePath = resolved.worktreePath
    resolvedCheckout = resolved
  }
  try {
    const attachments = input.attachments as Array<{ name: string; mime_type: string; data_base64: string }> | undefined
    if (attachments?.length) {
      const form = new FormData()
      form.append('workspace', JSON.stringify(body))
      for (const file of attachments)
        form.append(
          'attachments',
          new Blob([Buffer.from(file.data_base64, 'base64')], { type: file.mime_type }),
          file.name,
        )
      return await request(dispatch, '/api/workspaces', 'create', undefined, { method: 'POST', body: form })
    }
    return await request(dispatch, '/api/workspaces', 'create', body)
  } catch (error) {
    if (!resolvedCheckout) throw error
    if (!(error instanceof WorkspaceCreationMcpError))
      throw new WorkspaceCreationMcpError(error instanceof Error ? error.message : String(error), 500, 'create', {
        checkoutRecovery: {
          removed: false,
          worktreePath: resolvedCheckout.worktreePath,
          reason: 'Creation outcome is unknown; inspect the workspace and checkout before retrying',
        },
      })
    const checkoutRecovery = await rollbackCreatedPrCheckout(input.project_path as string, resolvedCheckout)
    throw new WorkspaceCreationMcpError(error.message, error.status, error.stage, {
      ...(error.details && typeof error.details === 'object' ? error.details : {}),
      checkoutRecovery,
    })
  }
}
