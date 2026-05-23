import { describe, expect, it } from 'vitest'
import { renderCiFixTemplate } from '../server/services/ci-fix-template-service.js'
import type { Workspace } from '../server/services/workspace-service.js'

const baseWorkspace: Workspace = {
  id: 'ws-1',
  name: 'Add auth flow',
  projectPath: '/home/user/projects/orion',
  sourceBranch: 'develop',
  workingBranch: 'feature/auth',
  status: 'executing',
  notionUrl: null,
  notionPageId: null,
  model: 'claude-opus-4-6',
  devServerStatus: 'stopped',
  createdAt: '2026-04-05T10:00:00.000Z',
  updatedAt: '2026-04-05T10:00:00.000Z',
}

describe('renderCiFixTemplate', () => {
  it('substitutes pr metadata and branch fields', () => {
    const out = renderCiFixTemplate(
      'PR {{pr_url}} (#{{pr_number}}) — {{pr_title}}\n{{branch_name}} → {{source_branch}}',
      {
        workspace: baseWorkspace,
        prNumber: 42,
        prUrl: 'https://github.com/org/repo/pull/42',
        prTitle: 'Add auth flow',
        failedChecks: [],
        ciRunUrl: null,
      },
    )
    expect(out).toBe('PR https://github.com/org/repo/pull/42 (#42) — Add auth flow\nfeature/auth → develop')
  })

  it('substitutes workspace and project identifiers', () => {
    const out = renderCiFixTemplate('{{workspace_name}}/{{workspace_id}} in {{project_name}}', {
      workspace: baseWorkspace,
      prNumber: 1,
      prUrl: 'x',
      prTitle: null,
      failedChecks: [],
      ciRunUrl: null,
    })
    expect(out).toBe('Add auth flow/ws-1 in orion')
  })

  it('formats failed_jobs as a bulleted list with detail URLs', () => {
    const out = renderCiFixTemplate('{{failed_jobs}}', {
      workspace: baseWorkspace,
      prNumber: 1,
      prUrl: 'x',
      prTitle: null,
      failedChecks: [
        { name: 'lint', detailsUrl: 'https://ci/runs/1' },
        { name: 'tests', detailsUrl: null },
      ],
      ciRunUrl: null,
    })
    expect(out).toBe('- lint — https://ci/runs/1\n- tests')
  })

  it('uses a placeholder string when failed_jobs is empty', () => {
    const out = renderCiFixTemplate('{{failed_jobs}}', {
      workspace: baseWorkspace,
      prNumber: 1,
      prUrl: 'x',
      prTitle: null,
      failedChecks: [],
      ciRunUrl: null,
    })
    expect(out).toBe('(no failed jobs reported)')
  })

  it('coerces null pr metadata to empty strings', () => {
    const out = renderCiFixTemplate('[{{pr_url}}][{{pr_number}}][{{pr_title}}][{{ci_run_url}}]', {
      workspace: baseWorkspace,
      prNumber: null,
      prUrl: null,
      prTitle: null,
      failedChecks: [],
      ciRunUrl: null,
    })
    expect(out).toBe('[][][][]')
  })

  it('leaves unknown variables intact', () => {
    const out = renderCiFixTemplate('Known: {{branch_name}}, unknown: {{custom_var}}', {
      workspace: baseWorkspace,
      prNumber: 1,
      prUrl: 'x',
      prTitle: null,
      failedChecks: [],
      ciRunUrl: null,
    })
    expect(out).toBe('Known: feature/auth, unknown: {{custom_var}}')
  })
})
