import type { ParallelReviewStatus, ReviewConfiguration } from '../../shared/review.js'
import { getDb } from '../db/index.js'
import { isParallelReviewCompacting } from './agent/orchestrator.js'
import { emitEphemeral } from './websocket-service.js'

export interface ParallelReview extends Omit<ParallelReviewStatus, 'compacting'> {
  original: ReviewConfiguration
  returnPrompt: string | null
}
export function getParallelReview(workspaceId: string): ParallelReview | null {
  const row = getDb().prepare('SELECT * FROM parallel_reviews WHERE workspace_id=?').get(workspaceId) as
    | {
        review_session_id: string
        original_session_id: string
        original_configuration: string
        return_to_session: number
        phase: ParallelReviewStatus['phase']
        return_prompt: string | null
        last_error: string | null
      }
    | undefined
  return row
    ? {
        reviewSessionId: row.review_session_id,
        originalSessionId: row.original_session_id,
        original: JSON.parse(row.original_configuration),
        returnToSession: !!row.return_to_session,
        phase: row.phase,
        returnPrompt: row.return_prompt,
        error: row.last_error,
      }
    : null
}
/** Preserve the captured source configuration only when its engine differs from the workspace default. */
export function getParallelReviewSourceConfiguration(
  workspaceId: string,
  sessionId: string | undefined,
  workspaceEngine: string,
): ReviewConfiguration | null {
  if (!sessionId) return null
  const review = getParallelReview(workspaceId)
  return review?.originalSessionId === sessionId && review.original.engine !== workspaceEngine ? review.original : null
}

export function getParallelReviewStatus(workspaceId: string): ParallelReviewStatus | null {
  const pending = getParallelReview(workspaceId)
  if (!pending) return null
  const { original: _original, returnPrompt: _prompt, ...status } = pending
  return { ...status, compacting: isParallelReviewCompacting(workspaceId) }
}
export function registerParallelReview(
  workspaceId: string,
  pending: Omit<ParallelReview, 'phase' | 'error' | 'returnPrompt'>,
): void {
  const current = getParallelReview(workspaceId)
  if (current && !['completed', 'interrupted'].includes(current.phase))
    throw new Error('A parallel review is already in progress')
  getDb()
    .prepare(`INSERT INTO parallel_reviews (workspace_id, review_session_id, original_session_id, original_configuration, return_to_session)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET review_session_id=excluded.review_session_id,
    original_session_id=excluded.original_session_id, original_configuration=excluded.original_configuration,
    return_to_session=excluded.return_to_session, phase='reviewing', return_prompt=NULL, last_error=NULL`)
    .run(
      workspaceId,
      pending.reviewSessionId,
      pending.originalSessionId,
      JSON.stringify(pending.original),
      Number(pending.returnToSession),
    )
  emitEphemeral(workspaceId, 'review:parallel-status', getParallelReviewStatus(workspaceId))
}
export function setParallelReviewPhase(
  workspaceId: string,
  phase: ParallelReviewStatus['phase'],
  error: string | null = null,
  prompt?: string,
): void {
  getDb()
    .prepare(
      'UPDATE parallel_reviews SET phase=?, last_error=?, return_prompt=COALESCE(?, return_prompt) WHERE workspace_id=?',
    )
    .run(phase, error, prompt ?? null, workspaceId)
  emitEphemeral(workspaceId, 'review:parallel-status', getParallelReviewStatus(workspaceId))
}
/** Settle only the report whose delivery is still pending. */
export function settleParallelReviewReturn(
  workspaceId: string,
  reviewSessionId: string,
  phase: 'completed' | 'unknown' | 'blocked',
  error: string | null = null,
): boolean {
  const changed =
    getDb()
      .prepare(
        "UPDATE parallel_reviews SET phase=?, last_error=? WHERE workspace_id=? AND review_session_id=? AND phase='dispatching'",
      )
      .run(phase, error, workspaceId, reviewSessionId).changes === 1
  if (changed) emitEphemeral(workspaceId, 'review:parallel-status', getParallelReviewStatus(workspaceId))
  return changed
}

export function reconcileParallelReviews(): void {
  getDb()
    .prepare(
      "UPDATE parallel_reviews SET phase=CASE WHEN return_to_session=1 THEN 'ready' ELSE 'completed' END WHERE phase='closing' AND return_prompt IS NOT NULL",
    )
    .run()
  getDb()
    .prepare(
      "UPDATE parallel_reviews SET phase='interrupted', last_error='Review interrupted by server restart' WHERE phase IN ('reviewing', 'closing')",
    )
    .run()
  getDb()
    .prepare(
      "UPDATE parallel_reviews SET phase='unknown', last_error='Server restarted during report delivery; inspect the source session before retrying' WHERE phase='dispatching'",
    )
    .run()
}
