import { validateProgressBarArguments } from '../../shared/progress-bar-tools.js'
import type {
  CreateProgressBarInput,
  FinishProgressBarInput,
  ProgressOwner,
  UpdateProgressBarInput,
} from '../../shared/progress-bars.js'
import {
  createProgressBar,
  finishProgressBar,
  listProgressBars,
  ProgressBarError,
  updateProgressBar,
} from './progress-bar-service.js'
export function executeProgressBarTool(
  name: string,
  input: unknown,
  internalOwner?: ProgressOwner & { kind: 'internal' },
) {
  let args: Record<string, unknown>
  try {
    args = validateProgressBarArguments(name, input, !internalOwner)
  } catch (error) {
    throw new ProgressBarError(400, 'invalid_arguments', error instanceof Error ? error.message : 'Invalid arguments')
  }
  const owner: ProgressOwner = internalOwner ?? {
    kind: 'external',
    workspaceId: args.workspace_id as string,
    sessionId: args.session_id as string,
  }
  switch (name) {
    case 'create_progress_bar': {
      const { activity_key, ...rest } = args
      const { workspace_id: _w, session_id: _s, ...values } = rest
      return createProgressBar(owner, { ...values, activityKey: activity_key } as unknown as CreateProgressBarInput)
    }
    case 'update_progress_bar':
    case 'finish_progress_bar': {
      const { workspace_id: _w, session_id: _s, progress_id, ...values } = args
      return name === 'update_progress_bar'
        ? updateProgressBar(owner, progress_id as string, values as unknown as UpdateProgressBarInput)
        : finishProgressBar(owner, progress_id as string, values as unknown as FinishProgressBarInput)
    }
    default:
      return listProgressBars({
        ...owner,
        limit: args.limit as number | undefined,
        offset: args.offset as number | undefined,
      })
  }
}
export function progressErrorData(error: ProgressBarError) {
  return {
    error: error.message,
    status: error.status,
    code: error.code,
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
  }
}
