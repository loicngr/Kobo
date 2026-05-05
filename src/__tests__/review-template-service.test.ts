import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REVIEW_PROMPT_TEMPLATE,
  type ReviewTemplateContext,
  renderReviewTemplate,
} from '../server/services/review-template-service.js'
import type { Workspace } from '../server/services/workspace-service.js'

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'Demo workspace',
    projectPath: '/home/user/projects/demo',
    sourceBranch: 'develop',
    workingBranch: 'feature/demo',
    status: 'idle',
    notionUrl: null,
    notionPageId: null,
    sentryUrl: null,
    model: 'claude-opus-4-7',
    reasoningEffort: 'medium',
    agentPermissionMode: 'interactive',
    devServerStatus: 'stopped',
    hasUnread: false,
    archivedAt: null,
    favoritedAt: null,
    tags: [],
    engine: 'claude-code',
    autoLoop: false,
    autoLoopReady: false,
    noProgressStreak: 0,
    worktreePath: '/tmp/demo',
    worktreeOwned: true,
    createdAt: '2026-04-05T10:00:00.000Z',
    updatedAt: '2026-04-05T10:00:00.000Z',
    ...overrides,
  }
}

function makeCtx(overrides: Partial<ReviewTemplateContext> = {}): ReviewTemplateContext {
  return {
    workspace: makeWorkspace(),
    commits: 'abc1234 feat: add thing',
    diffStats: ' src/foo.ts | 10 ++++--',
    baseCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    additionalInstructions: '',
    ...overrides,
  }
}

describe('renderReviewTemplate', () => {
  it('substitutes {{project_name}} from path basename', () => {
    const out = renderReviewTemplate('Project: {{project_name}}', makeCtx())
    expect(out).toBe('Project: demo')
  })

  it('substitutes {{workspace_name}}', () => {
    const out = renderReviewTemplate('WS: {{workspace_name}}', makeCtx())
    expect(out).toBe('WS: Demo workspace')
  })

  it('substitutes {{branch_name}} and {{source_branch}}', () => {
    const out = renderReviewTemplate('{{branch_name}} -> {{source_branch}}', makeCtx())
    expect(out).toBe('feature/demo -> develop')
  })

  it('substitutes {{base_commit}}', () => {
    const out = renderReviewTemplate('{{base_commit}}', makeCtx())
    expect(out).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
  })

  it('substitutes {{commits}} and {{diff_stats}}', () => {
    const out = renderReviewTemplate('C: {{commits}}; D: {{diff_stats}}', makeCtx())
    expect(out).toBe('C: abc1234 feat: add thing; D:  src/foo.ts | 10 ++++--')
  })

  it('substitutes {{notion_url}} as empty string when null', () => {
    const out = renderReviewTemplate('N=[{{notion_url}}]', makeCtx())
    expect(out).toBe('N=[]')
  })

  it('substitutes {{notion_url}} when set', () => {
    const out = renderReviewTemplate(
      '{{notion_url}}',
      makeCtx({ workspace: makeWorkspace({ notionUrl: 'https://notion.so/x' }) }),
    )
    expect(out).toBe('https://notion.so/x')
  })

  it('substitutes empty {{additional_instructions}} as "(none)"', () => {
    const out = renderReviewTemplate('I: {{additional_instructions}}', makeCtx())
    expect(out).toBe('I: (none)')
  })

  it('substitutes non-empty {{additional_instructions}} verbatim', () => {
    const out = renderReviewTemplate(
      '{{additional_instructions}}',
      makeCtx({ additionalInstructions: 'focus on perf' }),
    )
    expect(out).toBe('focus on perf')
  })

  it('leaves unknown placeholders intact', () => {
    const out = renderReviewTemplate('{{custom_var}} stays', makeCtx())
    expect(out).toBe('{{custom_var}} stays')
  })

  it('substitutes the same placeholder multiple times', () => {
    const out = renderReviewTemplate('{{base_commit}} {{base_commit}}', makeCtx())
    expect(out).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
  })

  it('returns empty string for empty template', () => {
    expect(renderReviewTemplate('', makeCtx())).toBe('')
  })
})

describe('DEFAULT_REVIEW_PROMPT_TEMPLATE', () => {
  it('is a non-empty string', () => {
    expect(typeof DEFAULT_REVIEW_PROMPT_TEMPLATE).toBe('string')
    expect(DEFAULT_REVIEW_PROMPT_TEMPLATE.length).toBeGreaterThan(50)
  })

  it('contains the key placeholders', () => {
    for (const placeholder of [
      '{{workspace_name}}',
      '{{project_name}}',
      '{{branch_name}}',
      '{{source_branch}}',
      '{{base_commit}}',
      '{{commits}}',
      '{{diff_stats}}',
      '{{additional_instructions}}',
    ]) {
      expect(DEFAULT_REVIEW_PROMPT_TEMPLATE).toContain(placeholder)
    }
  })

  it('mentions the superpowers code-review skill', () => {
    expect(DEFAULT_REVIEW_PROMPT_TEMPLATE).toMatch(/superpowers:requesting-code-review/i)
  })

  it('renders end-to-end with no leftover placeholders', () => {
    const out = renderReviewTemplate(
      DEFAULT_REVIEW_PROMPT_TEMPLATE,
      makeCtx({ additionalInstructions: 'focus on perf' }),
    )
    expect(out).not.toContain('{{')
    expect(out).toContain('Demo workspace')
    expect(out).toContain('focus on perf')
  })
})
