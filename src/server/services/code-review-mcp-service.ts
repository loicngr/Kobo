import { codeReviewRequest, validateCodeReviewArguments } from '../../shared/code-review-tools.js'

export async function executeCodeReviewTool(
  raw: unknown,
  dispatch: (path: string, init: RequestInit) => Promise<Response>,
) {
  const input = validateCodeReviewArguments(raw)
  const response = await dispatch(`/api/workspaces/${input.workspace_id}/start-review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(codeReviewRequest(input)),
  })
  const data = await response.json()
  return response.ok ? data : { accepted: false, error: data.error, status: response.status }
}
