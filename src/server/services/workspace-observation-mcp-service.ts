import { validateWorkspaceObservationArguments } from '../../shared/workspace-observation-tools.js'
import { listEngines } from './agent/engines/registry.js'
import { getMistralOptions } from './mistral-options-service.js'
import { getParallelReviewStatus } from './parallel-review-service.js'
import { getReviewReturnStatus } from './review-return-service.js'
import { getGlobalSettings } from './settings-service.js'
import { getSetupScriptStatus } from './setup-script-service.js'
import { getWorkspace } from './workspace-service.js'

export async function executeWorkspaceObservationTool(
  name: string,
  raw: unknown,
  dispatch: (path: string, init: RequestInit) => Promise<Response>,
) {
  const input = validateWorkspaceObservationArguments(name, raw)
  const id = input.workspace_id as string
  const workspace = getWorkspace(id)
  if (!workspace) throw new Error('Workspace not found')
  if (name === 'list_workspace_tags') return { tags: getGlobalSettings().tags, workspaceTags: workspace.tags }
  if (name === 'get_setup_script_status')
    return getSetupScriptStatus(
      id,
      input.run_id as string | undefined,
      input.after_id as string | undefined,
      input.limit as number | undefined,
    )
  if (name === 'list_agent_options') {
    const engines = listEngines()
      .filter((engine) => !input.engine || input.engine === engine.id)
      .map((engine) => ({ id: engine.id, displayName: engine.displayName, ...engine.capabilities }))
    const current = {
      engine: workspace.engine,
      model: workspace.model,
      reasoningEffort: workspace.reasoningEffort,
      agentPermissionMode: workspace.agentPermissionMode,
    }
    if (input.engine !== 'mistral-vibe') return { engines, current }
    const nativeOptions = await getMistralOptions({
      workspaceId: id,
      model: input.model as string | undefined,
      agentPermissionMode: input.agent_permission_mode as string | undefined,
    })
    return { engines, current, nativeOptions }
  }
  if (name === 'get_code_review_status')
    return { parallel: getParallelReviewStatus(id), return: getReviewReturnStatus(id) }
  const parallel = name === 'stop_code_review' || input.review_type === 'parallel'
  const status = parallel ? getParallelReviewStatus(id) : getReviewReturnStatus(id)
  if (!status || status.reviewSessionId !== input.session_id)
    throw new Error('Review session does not match the current review')
  const action = name === 'stop_code_review' ? 'stop' : name === 'retry_code_review_return' ? 'retry' : 'cancel'
  const suffix = parallel
    ? `parallel-review/${action === 'stop' ? action : `${action}-return`}`
    : `review-return/${action}`
  const response = await dispatch(`/api/workspaces/${id}/${suffix}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: input.session_id }),
  })
  const data = await response.json()
  return response.ok ? data : { accepted: false, error: data.error, status: response.status }
}
