import { describe, expect, it, vi } from 'vitest'
import { executeWorkspaceCreationTool } from '../server/services/workspace-creation-mcp-service.js'
import { validateWorkspaceCreationArguments } from '../shared/workspace-creation-tools.js'

const base = { name: 'Mission', project_path: '/repo', source_branch: 'develop', working_branch: 'feature/task' }
const prInput = { name: 'PR', project_path: '/repo', pr_url: 'https://github.com/team/repo/pull/12' }
function diagnosis(overrides = {}) {
  return {
    fingerprint: 'fresh',
    pr: { number: 12, url: prInput.pr_url, headBranch: 'feature/pr', baseBranch: 'main' },
    report: {
      projectPath: '/repo',
      headBranch: 'feature/pr',
      targetWorktreePath: '/trees/pr',
      blockers: [],
      workspace: { state: 'none' },
      worktree: { state: 'none' },
      localChanges: { present: false, modified: 0, staged: 0, untracked: 0 },
      ongoingOperation: null,
      branch: { state: 'absent' },
      ...overrides,
    },
  }
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
describe('MCP workspace creation', () => {
  it('validates a large canonical upload without overflowing the regexp stack', () => {
    expect(() =>
      validateWorkspaceCreationArguments('create_workspace', {
        ...base,
        attachments: [
          { name: 'large.md', mime_type: 'text/plain', data_base64: Buffer.alloc(1024 * 1024, 'a').toString('base64') },
        ],
      }),
    ).not.toThrow()
  })
  it('supports auto effort and an explicitly disabled final reviewer', async () => {
    const dispatch = vi.fn().mockResolvedValue(response({ id: 'new' }))
    await executeWorkspaceCreationTool(
      'create_workspace',
      { ...base, reasoning_effort: 'auto', auto_loop_final_review: null },
      dispatch,
    )
    expect(JSON.parse(dispatch.mock.calls[0]![1].body)).toMatchObject({
      reasoningEffort: 'auto',
      autoLoopFinalReview: null,
    })
  })
  it('rejects unsupported reviewer effort before checkout', async () => {
    const dispatch = vi.fn()
    await expect(
      executeWorkspaceCreationTool(
        'create_workspace',
        { ...prInput, auto_loop_final_review: { engine: 'claude-code', model: 'opus', reasoning_effort: 'none' } },
        dispatch,
      ),
    ).rejects.toMatchObject({ status: 400, stage: 'validate' })
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('rejects metadata too large for the downstream multipart request before checkout', async () => {
    const dispatch = vi.fn()
    await expect(
      executeWorkspaceCreationTool(
        'create_workspace',
        { ...prInput, tasks: Array.from({ length: 100 }, () => 'a'.repeat(20_000)) },
        dispatch,
      ),
    ).rejects.toThrow('metadata exceeds')
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('diagnoses without performing checkout', async () => {
    const dispatch = vi.fn().mockResolvedValue(response(diagnosis()))
    expect(
      await executeWorkspaceCreationTool(
        'diagnose_workspace_pr',
        { project_path: '/repo', pr_url: prInput.pr_url },
        dispatch,
      ),
    ).toEqual(diagnosis())
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
  it('rejects a different repository URL with the same PR number before checkout', async () => {
    const dispatch = vi.fn().mockResolvedValue(response(diagnosis()))
    await expect(
      executeWorkspaceCreationTool(
        'create_workspace',
        { ...prInput, pr_url: 'https://github.com/other/repo/pull/12' },
        dispatch,
      ),
    ).rejects.toMatchObject({ status: 400, stage: 'diagnose' })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
  it('unarchives only with an explicit fresh choice, without creating or checking out', async () => {
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce(
        response(diagnosis({ workspace: { state: 'archived', id: 'existing', name: 'Existing' } })),
      )
      .mockResolvedValueOnce(response({ id: 'existing' }))
    expect(
      await executeWorkspaceCreationTool(
        'create_workspace',
        { ...prInput, pr_checkout: { fingerprint: 'fresh', decisions: { archivedWorkspace: 'unarchive' } } },
        dispatch,
      ),
    ).toMatchObject({ created: false, workspaceId: 'existing' })
    expect(dispatch.mock.calls.map(([path]) => path)).toEqual([
      '/api/pull-requests/diagnose',
      '/api/workspaces/existing/unarchive',
    ])
  })
  it.each(['ahead', 'diverged'])('refuses a fast-forward that would lose local commits (%s)', async (state) => {
    const dispatch = vi.fn().mockResolvedValue(response(diagnosis({ branch: { state, ahead: 1, behind: 1 } })))
    await expect(
      executeWorkspaceCreationTool(
        'create_workspace',
        {
          ...prInput,
          pr_checkout: { fingerprint: 'fresh', decisions: { divergence: 'fast-forward' } },
        },
        dispatch,
      ),
    ).rejects.toMatchObject({ status: 400, stage: 'validate-checkout' })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
  it('refuses a hard reset that conflicts with preserving local edits', async () => {
    const dispatch = vi
      .fn()
      .mockResolvedValue(
        response(diagnosis({ localChanges: { present: true }, branch: { state: 'diverged', ahead: 1, behind: 1 } })),
      )
    await expect(
      executeWorkspaceCreationTool(
        'create_workspace',
        {
          ...prInput,
          pr_checkout: { fingerprint: 'fresh', decisions: { localChanges: 'keep', divergence: 'reset-hard' } },
        },
        dispatch,
      ),
    ).rejects.toMatchObject({ status: 400, stage: 'validate-checkout' })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
  it('preserves explicit setup execution for PR checkout', async () => {
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce(response(diagnosis()))
      .mockResolvedValueOnce(response({ worktreePath: '/trees/pr' }))
      .mockResolvedValueOnce(response({ id: 'new' }))
    await executeWorkspaceCreationTool('create_workspace', { ...prInput, skip_setup_script: false }, dispatch)
    expect(JSON.parse(dispatch.mock.calls[2]![1].body).skipSetupScript).toBe(false)
  })
  it('maps creation settings including final reviewer and workflow policy', async () => {
    const dispatch = vi.fn().mockResolvedValue(response({ id: 'new' }))
    await executeWorkspaceCreationTool(
      'create_workspace',
      {
        ...base,
        brainstorm_model: 'opus',
        brainstorm_reasoning_effort: 'high',
        auto_loop: true,
        auto_loop_final_review: {
          engine: 'codex',
          model: 'custom',
          reasoning_effort: 'high',
          additional_instructions: 'Inspect',
        },
        workflow_policy: { commit: 'automatic', push: 'manual', publish: 'manual' },
        comparison_id: 'pair',
        creation_id: 'request',
        notion_page_id: 'page',
      },
      dispatch,
    )
    expect(JSON.parse(dispatch.mock.calls[0]![1].body)).toMatchObject({
      brainstormModel: 'opus',
      brainstormReasoningEffort: 'high',
      autoLoop: true,
      autoLoopFinalReview: {
        engine: 'codex',
        model: 'custom',
        reasoningEffort: 'high',
        additionalInstructions: 'Inspect',
      },
      workflowPolicy: { commit: 'automatic', push: 'manual', publish: 'manual' },
      comparisonId: 'pair',
      creationId: 'request',
      notionPageId: 'page',
    })
  })
  it.each([
    { unexpected: true },
    { auto_loop: 'yes' },
    { workflow_policy: { commit: 'yes' } },
    { attachments: [{ name: 'a.md', mime_type: 'text/plain', data_base64: '%%%=' }] },
    { attachments: [{ name: 'a.exe', mime_type: 'application/octet-stream', data_base64: 'YQ==' }] },
    { attachments: [{ name: 'a.md', mime_type: 'text/plain', data_base64: 'YR==' }] },
  ])('rejects invalid arguments before any PR side effects: %j', async (invalid) => {
    const dispatch = vi.fn()
    await expect(
      executeWorkspaceCreationTool('create_workspace', { ...prInput, ...invalid }, dispatch),
    ).rejects.toThrow()
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('encodes attachments as the existing multipart API, never paths', async () => {
    const dispatch = vi.fn().mockResolvedValue(response({ id: 'new' }))
    await executeWorkspaceCreationTool(
      'create_workspace',
      { ...base, attachments: [{ name: 'notes.md', mime_type: 'text/markdown', data_base64: 'aGVsbG8=' }] },
      dispatch,
    )
    const body = dispatch.mock.calls[0]![1].body as FormData
    expect(JSON.parse(body.get('workspace') as string)).toMatchObject({ projectPath: '/repo' })
    expect(await (body.get('attachments') as File).text()).toBe('hello')
  })
  it('diagnoses then resolves a clean PR and creates with canonical branches and skip setup', async () => {
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce(response(diagnosis()))
      .mockResolvedValueOnce(response({ worktreePath: '/trees/pr', sourceBranch: 'main', workingBranch: 'feature/pr' }))
      .mockResolvedValueOnce(response({ id: 'new' }))
    await executeWorkspaceCreationTool('create_workspace', prInput, dispatch)
    expect(dispatch.mock.calls.map(([path]) => path)).toEqual([
      '/api/pull-requests/diagnose',
      '/api/pull-requests/resolve',
      '/api/workspaces',
    ])
    expect(JSON.parse(dispatch.mock.calls[2]![1].body)).toMatchObject({
      sourceBranch: 'main',
      workingBranch: 'feature/pr',
      worktreePath: '/trees/pr',
      prUrl: prInput.pr_url,
      skipSetupScript: true,
    })
  })
  it('requires explicit fresh decisions for local changes instead of discarding', async () => {
    const dispatch = vi.fn().mockResolvedValue(response(diagnosis({ localChanges: { present: true } })))
    expect(await executeWorkspaceCreationTool('create_workspace', prInput, dispatch)).toMatchObject({
      created: false,
      requiresAction: true,
      fingerprint: 'fresh',
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
  it('rejects stale decisions without resolving or creating', async () => {
    const dispatch = vi.fn().mockResolvedValue(response(diagnosis()))
    await expect(
      executeWorkspaceCreationTool(
        'create_workspace',
        { ...prInput, pr_checkout: { fingerprint: 'old', decisions: { divergence: 'reset-hard' } } },
        dispatch,
      ),
    ).rejects.toMatchObject({ status: 409, stage: 'diagnose' })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
  it.each(['active', 'archived', 'purged'])('never duplicates an existing %s workspace by default', async (state) => {
    const dispatch = vi
      .fn()
      .mockResolvedValue(response(diagnosis({ workspace: { state, id: 'existing', name: 'Existing' } })))
    expect(await executeWorkspaceCreationTool('create_workspace', prInput, dispatch)).toMatchObject({
      created: false,
      requiresAction: true,
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
  it('opens the existing workspace without starting a second agent', async () => {
    const dispatch = vi
      .fn()
      .mockResolvedValue(response(diagnosis({ workspace: { state: 'active', id: 'existing', name: 'Existing' } })))
    expect(
      await executeWorkspaceCreationTool(
        'create_workspace',
        { ...prInput, pr_checkout: { fingerprint: 'fresh', decisions: { existingWorkspace: 'open' } } },
        dispatch,
      ),
    ).toMatchObject({ created: false, workspaceId: 'existing' })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
  it('preserves stage and structured backend errors', async () => {
    const dispatch = vi.fn().mockResolvedValue(response({ error: 'Denied', report: { reason: 'busy' } }, 409))
    await expect(executeWorkspaceCreationTool('create_workspace', base, dispatch)).rejects.toMatchObject({
      status: 409,
      stage: 'create',
      details: { error: 'Denied', report: { reason: 'busy' } },
    })
  })
  it('requires branches for plain creation but derives them for PRs', () => {
    expect(() => validateWorkspaceCreationArguments('create_workspace', { name: 'a', project_path: '/repo' })).toThrow()
    expect(() => validateWorkspaceCreationArguments('create_workspace', prInput)).not.toThrow()
  })
})
