import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, getDb } from '../server/db/index.js'
import { initSchema } from '../server/db/schema.js'
import { createIdleSession, createTask, createWorkspace } from '../server/services/workspace-service.js'

vi.mock('../server/services/websocket-service.js', () => ({ emit: vi.fn(), emitEphemeral: vi.fn() }))
vi.mock('../server/services/agent/orchestrator.js', () => ({
  hasController: vi.fn(() => true),
  isShuttingDown: vi.fn(() => false),
  getAgentStatus: vi.fn(() => 'running'),
  getActiveSessionId: vi.fn(),
}))
vi.mock('../server/services/review-service.js', async (original) => {
  const actual = await original<typeof import('../server/services/review-service.js')>()
  return { ...actual, startWorkspaceReview: vi.fn(async () => ({ ok: true })) }
})
const config = {
  engine: 'claude-code',
  model: 'auto',
  reasoningEffort: 'auto',
  additionalInstructions: 'Review everything',
}
let dir: string
let id: string
let originalId: string
let reviewId: string
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-final-review-'))
  initSchema(getDb(path.join(dir, 'test.db')))
  id = createWorkspace({ name: 'test', projectPath: dir, sourceBranch: 'main', workingBranch: 'feature/test' }).id
  originalId = createIdleSession(id).id
  reviewId = createIdleSession(id).id
  const orch = await import('../server/services/agent/orchestrator.js')
  vi.mocked(orch.getActiveSessionId).mockImplementation(
    () =>
      (
        getDb().prepare('SELECT review_session_id FROM auto_loop_final_reviews WHERE workspace_id=?').get(id) as
          | { review_session_id: string }
          | undefined
      )?.review_session_id,
  )
  getDb().prepare('UPDATE workspaces SET auto_loop=1, auto_loop_ready=1 WHERE id=?').run(id)
})
afterEach(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})
describe('durable final review', () => {
  it('stores independent configuration and rejects unavailable engines', async () => {
    const svc = await import('../server/services/auto-loop-final-review-service.js')
    expect(svc.getFinalReviewStatus(id).state).toBe('disabled')
    expect(svc.configureFinalReview(id, config)).toMatchObject({ configuration: config, state: 'pending', cycle: 0 })
    expect(() => svc.configureFinalReview(id, { ...config, engine: 'unknown' })).toThrow('engine')
    closeDb()
    getDb(path.join(dir, 'test.db'))
    expect(svc.getFinalReviewStatus(id).configuration).toEqual(config)
  })
  it('accepts a structured verdict only from the bound reviewer and invalidates finalization', async () => {
    const svc = await import('../server/services/auto-loop-final-review-service.js')
    svc.configureFinalReview(id, config)
    const final = createTask(id, { title: '[FINAL] Verify everything' })
    getDb().prepare("UPDATE tasks SET status='done', verification='{}' WHERE id=?").run(final.id)
    const launch = svc.bindReviewSession(id, reviewId, originalId)
    const report = {
      summary: 'One bug',
      findings: [
        {
          severity: 'important',
          file: 'src/a.ts',
          line: 3,
          description: 'Wrong result',
          recommendation: 'Correct the return value',
        },
      ],
    }
    expect(() => svc.submitFinalReviewReport(id, reviewId, 'invalid', report)).toThrow()
    svc.submitFinalReviewReport(id, reviewId, launch.mcpEnv.KOBO_FINAL_REVIEW_TOKEN, report)
    expect(svc.prepareAutoLoopReviewReturn(id, reviewId)).toContain('Wrong result')
    expect(svc.getFinalReviewStatus(id)).toMatchObject({
      state: 'fixing',
      findingsCount: 1,
      originalSessionId: originalId,
    })
    expect(getDb().prepare('SELECT status FROM tasks WHERE id=?').get(final.id)).toEqual({ status: 'pending' })
    const taskCount = (getDb().prepare('SELECT COUNT(*) AS n FROM tasks WHERE workspace_id=?').get(id) as { n: number })
      .n
    svc.prepareAutoLoopReviewReturn(id, reviewId)
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM tasks WHERE workspace_id=?').get(id) as { n: number }).n).toBe(
      taskCount,
    )
  })
  it('never treats missing prose or a missing verdict as a passing review', async () => {
    const svc = await import('../server/services/auto-loop-final-review-service.js')
    svc.configureFinalReview(id, config)
    svc.bindReviewSession(id, reviewId, originalId)
    expect(() => svc.prepareAutoLoopReviewReturn(id, reviewId)).toThrow('verdict')
    expect(svc.getFinalReviewStatus(id).state).toBe('blocked')
  })
})

it('waits for original session closure before accepting a clean verdict', async () => {
  const svc = await import('../server/services/auto-loop-final-review-service.js')
  svc.configureFinalReview(id, config)
  const launch = svc.bindReviewSession(id, reviewId, originalId)
  svc.submitFinalReviewReport(id, reviewId, launch.mcpEnv.KOBO_FINAL_REVIEW_TOKEN, {
    summary: 'Everything passes',
    findings: [],
  })
  svc.prepareAutoLoopReviewReturn(id, reviewId)
  expect(svc.getFinalReviewStatus(id).state).toBe('fixing')
  svc.onFinalReviewCorrectionEnded(id, 'killed', originalId)
  expect(svc.getFinalReviewStatus(id).state).toBe('fixing')
  svc.onFinalReviewCorrectionEnded(id, 'completed', originalId)
  expect(svc.getFinalReviewStatus(id).state).toBe('completed')
})

it('rejects a capability after the original reviewer stops', async () => {
  const svc = await import('../server/services/auto-loop-final-review-service.js')
  const orch = await import('../server/services/agent/orchestrator.js')
  svc.configureFinalReview(id, config)
  const launch = svc.bindReviewSession(id, reviewId, originalId)
  vi.mocked(orch.getAgentStatus).mockReturnValueOnce('stopping')
  expect(() =>
    svc.submitFinalReviewReport(id, reviewId, launch.mcpEnv.KOBO_FINAL_REVIEW_TOKEN, {
      summary: 'clear',
      findings: [],
    }),
  ).toThrow('capability')
})

it('blocks persistent repeated findings after diagnostic recovery, without limiting productive cycles', async () => {
  const svc = await import('../server/services/auto-loop-final-review-service.js')
  svc.configureFinalReview(id, config)
  const finding = { severity: 'minor', file: 'src/a.ts', description: 'Still broken', recommendation: 'Fix it' }
  for (let cycle = 0; cycle < 7; cycle++) {
    const session = createIdleSession(id).id
    const launch = svc.bindReviewSession(id, session, originalId)
    svc.submitFinalReviewReport(id, session, launch.mcpEnv.KOBO_FINAL_REVIEW_TOKEN, {
      summary: 'Review',
      findings: [finding],
    })
    if (cycle < 6) {
      const prompt = svc.prepareAutoLoopReviewReturn(id, session)
      expect(prompt).not.toBeNull()
      if (cycle === 3) expect(prompt).toContain('DIAGNOSTIC')
      else expect(prompt).not.toContain('DIAGNOSTIC')
    } else expect(() => svc.prepareAutoLoopReviewReturn(id, session)).toThrow('no progress')
  }
  expect(svc.getFinalReviewStatus(id).state).toBe('blocked')
  svc.retryAutoLoopReviewReturn(id, true)
  for (let cycle = 0; cycle < 8; cycle++) {
    const session = createIdleSession(id).id
    const launch = svc.bindReviewSession(id, session, originalId)
    svc.submitFinalReviewReport(id, session, launch.mcpEnv.KOBO_FINAL_REVIEW_TOKEN, {
      summary: 'Review',
      findings: [{ ...finding, description: `Distinct remaining issue ${cycle}` }],
    })
    expect(svc.prepareAutoLoopReviewReturn(id, session)).toContain(`Distinct remaining issue ${cycle}`)
  }
  expect(svc.getFinalReviewStatus(id).state).toBe('fixing')
})

it('rejects incomplete verdicts and keeps a submitted verdict immutable', async () => {
  const svc = await import('../server/services/auto-loop-final-review-service.js')
  svc.configureFinalReview(id, config)
  const launch = svc.bindReviewSession(id, reviewId, originalId)
  const token = launch.mcpEnv.KOBO_FINAL_REVIEW_TOKEN
  for (const report of [
    'looks fine',
    { summary: '', findings: [] },
    { summary: 'fine', findings: [{ description: 'bug' }] },
  ])
    expect(() => svc.submitFinalReviewReport(id, reviewId, token, report)).toThrow()
  svc.submitFinalReviewReport(id, reviewId, token, { summary: 'fine', findings: [] })
  svc.submitFinalReviewReport(id, reviewId, token, { summary: 'fine', findings: [] })
  expect(() => svc.submitFinalReviewReport(id, reviewId, token, { summary: 'different', findings: [] })).toThrow(
    'already submitted',
  )
})

it('preserves verdict and original session on restart while keeping tokens out of public status', async () => {
  const svc = await import('../server/services/auto-loop-final-review-service.js')
  svc.configureFinalReview(id, config)
  const launch = svc.bindReviewSession(id, reviewId, originalId)
  svc.submitFinalReviewReport(id, reviewId, launch.mcpEnv.KOBO_FINAL_REVIEW_TOKEN, { summary: 'clear', findings: [] })
  closeDb()
  getDb(path.join(dir, 'test.db'))
  expect(svc.getFinalReviewStatus(id)).toMatchObject({
    state: 'reviewing',
    findingsCount: 0,
    originalSessionId: originalId,
    reviewSessionId: reviewId,
  })
  expect(JSON.stringify(svc.getFinalReviewStatus(id))).not.toContain(launch.mcpEnv.KOBO_FINAL_REVIEW_TOKEN)
  expect(svc.getAutoLoopReviewLaunch(id, reviewId)).toEqual(launch)
  expect(svc.prepareAutoLoopReviewReturn(id, reviewId)).toContain('clear')
})

it('renews reviewer capability only through explicit retry after a blocked report', async () => {
  const svc = await import('../server/services/auto-loop-final-review-service.js')
  svc.configureFinalReview(id, config)
  const launch = svc.bindReviewSession(id, reviewId, originalId)
  expect(() => svc.prepareAutoLoopReviewReturn(id, reviewId)).toThrow()
  svc.retryAutoLoopReviewReturn(id, true)
  const retry = svc.getAutoLoopReviewLaunch(id, reviewId)!
  expect(retry.mcpEnv.KOBO_FINAL_REVIEW_TOKEN).not.toBe(launch.mcpEnv.KOBO_FINAL_REVIEW_TOKEN)
  expect(() =>
    svc.submitFinalReviewReport(id, reviewId, launch.mcpEnv.KOBO_FINAL_REVIEW_TOKEN, {
      summary: 'clear',
      findings: [],
    }),
  ).toThrow()
  svc.submitFinalReviewReport(id, reviewId, retry.mcpEnv.KOBO_FINAL_REVIEW_TOKEN, { summary: 'clear', findings: [] })
})

it('never accepts a report from a replaced controller or a different workspace', async () => {
  const svc = await import('../server/services/auto-loop-final-review-service.js')
  const orch = await import('../server/services/agent/orchestrator.js')
  svc.configureFinalReview(id, config)
  const launch = svc.bindReviewSession(id, reviewId, originalId)
  vi.mocked(orch.getActiveSessionId).mockReturnValueOnce(originalId)
  expect(() =>
    svc.submitFinalReviewReport(id, reviewId, launch.mcpEnv.KOBO_FINAL_REVIEW_TOKEN, {
      summary: 'clear',
      findings: [],
    }),
  ).toThrow('capability')
})

it('cannot prepare automatic fixes after the user disables auto-loop', async () => {
  const svc = await import('../server/services/auto-loop-final-review-service.js')
  svc.configureFinalReview(id, config)
  const launch = svc.bindReviewSession(id, reviewId, originalId)
  svc.submitFinalReviewReport(id, reviewId, launch.mcpEnv.KOBO_FINAL_REVIEW_TOKEN, { summary: 'clear', findings: [] })
  getDb().prepare('UPDATE workspaces SET auto_loop=0 WHERE id=?').run(id)
  svc.cancelAutoLoopFinalReview(id, 'user-action')
  expect(() => svc.prepareAutoLoopReviewReturn(id, reviewId)).toThrow('cancelled')
})

it('credits a clean review only to closure of the exact original session', async () => {
  const svc = await import('../server/services/auto-loop-final-review-service.js')
  svc.configureFinalReview(id, config)
  const launch = svc.bindReviewSession(id, reviewId, originalId)
  svc.submitFinalReviewReport(id, reviewId, launch.mcpEnv.KOBO_FINAL_REVIEW_TOKEN, { summary: 'clear', findings: [] })
  svc.prepareAutoLoopReviewReturn(id, reviewId)
  svc.onFinalReviewCorrectionEnded(id, 'completed', reviewId)
  expect(svc.getFinalReviewStatus(id).state).toBe('fixing')
  svc.onFinalReviewCorrectionEnded(id, 'completed', originalId)
  expect(svc.getFinalReviewStatus(id).state).toBe('completed')
})

it('preserves configured custom models through a saved workspace preset', async () => {
  const svc = await import('../server/services/auto-loop-final-review-service.js')
  const presets = await import('../server/services/workspace-template-service.js')
  const custom = { ...config, model: 'custom-provider-model' }
  expect(svc.configureFinalReview(id, custom).configuration).toEqual(custom)
  const preset = presets.presetFromWorkspace(id)!
  expect(presets.sanitizePreset(preset).autoLoopFinalReview).toEqual(custom)
  expect(() => svc.configureFinalReview(id, { ...custom, model: 'x'.repeat(201) })).toThrow('model')
})

it('keeps stopped source sessions while their durable review return still needs them', async () => {
  const svc = await import('../server/services/auto-loop-final-review-service.js')
  const { registerReviewReturn } = await import('../server/services/review-return-service.js')
  const { deleteSession } = await import('../server/services/workspace-service.js')
  const original = { ...config, agentPermissionMode: 'bypass' as const }
  registerReviewReturn({
    workspaceId: id,
    originalSessionId: originalId,
    reviewSessionId: reviewId,
    original,
    review: { ...original, agentPermissionMode: 'plan' },
  })
  expect(() => deleteSession(originalId, id)).toThrow('review')
  expect(() => deleteSession(reviewId, id)).toThrow('review')
  getDb().prepare('DELETE FROM pending_review_returns WHERE workspace_id=?').run(id)
  svc.configureFinalReview(id, config)
  const launch = svc.bindReviewSession(id, reviewId, originalId)
  svc.submitFinalReviewReport(id, reviewId, launch.mcpEnv.KOBO_FINAL_REVIEW_TOKEN, { summary: 'clear', findings: [] })
  svc.prepareAutoLoopReviewReturn(id, reviewId)
  expect(() => deleteSession(originalId, id)).toThrow('review')
  svc.onFinalReviewCorrectionEnded(id, 'completed', originalId)
  expect(deleteSession(originalId, id)).toBe(true)
})

it('keeps an actionable blocked runtime when an ambiguous automatic return is cancelled', async () => {
  const svc = await import('../server/services/auto-loop-final-review-service.js')
  const { getRuntime } = await import('../server/services/auto-loop-state-service.js')
  svc.configureFinalReview(id, config)
  svc.bindReviewSession(id, reviewId, originalId)
  svc.cancelAutoLoopFinalReview(id, 'review-return-cancelled')
  expect(getRuntime(id)).toMatchObject({ state: 'blocked', reason: 'review-return-cancelled' })
})

it('waits instead of blocking when capacity changes during review preparation', async () => {
  const svc = await import('../server/services/auto-loop-final-review-service.js')
  const review = await import('../server/services/review-service.js')
  const { getRuntime } = await import('../server/services/auto-loop-state-service.js')
  svc.configureFinalReview(id, config)
  vi.mocked(review.startWorkspaceReview).mockRejectedValueOnce(new review.ReviewAdmissionDeferred())
  svc.advanceFinalReview(id)
  await new Promise((resolve) => setImmediate(resolve))
  expect(getRuntime(id)).toMatchObject({ state: 'waiting', reason: 'final-review-capacity' })
  expect(svc.getFinalReviewStatus(id).state).toBe('pending')
})
