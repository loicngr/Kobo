import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { closeDb, getDb } from '../server/db/index.js'
import { getParallelReview } from '../server/services/parallel-review-service.js'
import { listReviewReturns, reconcileReviewReturns } from '../server/services/review-return-service.js'
import { reconcileSessionHandoffs } from '../server/services/session-handoff-service.js'
import { _setSettingsPath } from '../server/services/settings-service.js'
import {
  reconcileGroupMessageBatches,
  stopGroupMessageBatches,
} from '../server/services/workspace-group-message-service.js'
import { workspaceLifecycleReason } from '../server/utils/workspace-lifecycle-guard.js'
import { resetDb } from './helpers/reset-db.js'

// A single unreadable JSON column must never keep the server from booting.
beforeEach(async () => {
  const { tmpDir } = await resetDb()
  _setSettingsPath(`${tmpDir}/settings.json`)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  getDb().exec(`
    INSERT INTO workspaces(id,name,project_path,source_branch,working_branch,status,created_at,updated_at)
    VALUES ('w1','Workspace','/tmp','main','work','idle','now','now');
    INSERT INTO agent_sessions(id,workspace_id,status,started_at) VALUES ('source','w1','completed','now'),('review','w1','completed','now');
  `)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await stopGroupMessageBatches()
  closeDb()
})

it('reconciles readable group receipts and skips an unreadable one', () => {
  const db = getDb()
  const pending = { complete: false, recipients: [{ workspaceId: 'w1', state: 'pending' }] }
  db.prepare('INSERT INTO workspace_message_batches VALUES (?,?,?,?)').run('broken', 'f', '{"complete":', 'now')
  db.prepare('INSERT INTO workspace_message_batches VALUES (?,?,?,?)').run('ok', 'f', JSON.stringify(pending), 'now')

  expect(() => reconcileGroupMessageBatches(db)).not.toThrow()

  const receipt = (id: string) =>
    (db.prepare('SELECT receipt_json FROM workspace_message_batches WHERE id = ?').get(id) as { receipt_json: string })
      .receipt_json
  expect(JSON.parse(receipt('ok'))).toMatchObject({ complete: true, recipients: [{ state: 'not_sent' }] })
  expect(receipt('broken')).toBe('{"complete":')
  expect(console.error).toHaveBeenCalled()
})

it('skips an unreadable review return at startup and leaves its row in place', () => {
  getDb()
    .prepare(
      `INSERT INTO pending_review_returns (workspace_id, review_session_id, original_session_id, original_configuration, review_configuration, created_at)
       VALUES ('w1', 'review', 'source', '{', '{}', 'now')`,
    )
    .run()

  expect(() => reconcileReviewReturns()).not.toThrow()

  expect(listReviewReturns()).toEqual([])
  expect(getDb().prepare('SELECT COUNT(*) AS count FROM pending_review_returns').get()).toEqual({ count: 1 })
})

it('cancels an unreadable session transfer at startup without reserving the workspace', () => {
  getDb()
    .prepare(
      `INSERT INTO session_handoffs (id, workspace_id, request_id, request_fingerprint, source_session_id, source_configuration,
         target_configuration, generate_summary, state, generation_token, created_at, updated_at)
       VALUES ('h1', 'w1', 'r1', 'f', 'source', '{', '{}', 0, 'generating', 'token', 'now', 'now')`,
    )
    .run()

  expect(() => reconcileSessionHandoffs()).not.toThrow()

  expect(getDb().prepare('SELECT state, generation_token, error FROM session_handoffs').get()).toMatchObject({
    state: 'cancelled',
    generation_token: null,
    error: expect.stringContaining('unreadable'),
  })
  expect(workspaceLifecycleReason('w1')).toBeFalsy()
})

it('treats an unreadable parallel review as absent', () => {
  getDb()
    .prepare(
      `INSERT INTO parallel_reviews (workspace_id, review_session_id, original_session_id, original_configuration, return_to_session, phase)
       VALUES ('w1', 'review', 'source', '{', 1, 'ready')`,
    )
    .run()

  expect(getParallelReview('w1')).toBeNull()
})
