import { describe, expect, it } from 'vitest'
import { buildTemplateVars, expandTemplate } from '../utils/expand-template'

describe('expandTemplate()', () => {
  it('substitutes a single variable', () => {
    expect(expandTemplate('Hello {workspace_name}', { workspace_name: 'foo' })).toBe('Hello foo')
  })

  it('substitutes multiple different variables', () => {
    expect(
      expandTemplate('{workspace_name} on {working_branch}', {
        workspace_name: 'foo',
        working_branch: 'feature/bar',
      }),
    ).toBe('foo on feature/bar')
  })

  it('substitutes the same variable multiple times', () => {
    expect(expandTemplate('{workspace_name} x {workspace_name}', { workspace_name: 'foo' })).toBe('foo x foo')
  })

  it('leaves unknown variables as-is', () => {
    expect(expandTemplate('Hello {missing}', {})).toBe('Hello {missing}')
  })

  it('leaves empty {} as-is', () => {
    expect(expandTemplate('Hello {} world', {})).toBe('Hello {} world')
  })

  it('leaves unclosed {incomplete as-is', () => {
    expect(expandTemplate('Hello {incomplete world', {})).toBe('Hello {incomplete world')
  })

  it('matches inner brace pair in {{double}} and leaves outer braces', () => {
    // The regex \{(\w+)\} matches the inner {double}; outer braces stay
    expect(expandTemplate('{{workspace_name}}', { workspace_name: 'foo' })).toBe('{foo}')
  })

  it('coerces numeric values to strings', () => {
    expect(expandTemplate('{commit_count} commits', { commit_count: 5 })).toBe('5 commits')
  })

  it('converts 0 to "0" (not falsy-dropped)', () => {
    expect(expandTemplate('{commit_count}', { commit_count: 0 })).toBe('0')
  })
})

describe('buildTemplateVars()', () => {
  it('returns all workspace + git + session vars when everything is available', () => {
    const vars = buildTemplateVars({
      workspace: {
        name: 'my-workspace',
        workingBranch: 'feature/test',
        sourceBranch: 'main',
        projectPath: '/tmp/project',
      },
      gitStats: {
        commitCount: 3,
        unpushedCount: 1,
        filesChanged: 12,
        insertions: 100,
        deletions: 50,
        prNumber: 42,
        prUrl: 'https://github.com/org/repo/pull/42',
        prState: 'OPEN',
      },
      sessionName: 'Session #1',
    })
    expect(vars).toEqual({
      workspace_name: 'my-workspace',
      working_branch: 'feature/test',
      source_branch: 'main',
      project_path: '/tmp/project',
      worktree_path: '/tmp/project/.worktrees/feature/test',
      commit_count: 3,
      unpushed_count: 1,
      files_changed: 12,
      insertions: 100,
      deletions: 50,
      pr_number: 42,
      pr_url: 'https://github.com/org/repo/pull/42',
      pr_state: 'OPEN',
      session_name: 'Session #1',
    })
  })

  it('omits all workspace vars when workspace is null', () => {
    const vars = buildTemplateVars({ workspace: null, gitStats: null, sessionName: null })
    expect(vars.workspace_name).toBeUndefined()
    expect(vars.working_branch).toBeUndefined()
    expect(vars.source_branch).toBeUndefined()
    expect(vars.project_path).toBeUndefined()
    expect(vars.worktree_path).toBeUndefined()
  })

  it('omits all git vars when gitStats is null', () => {
    const vars = buildTemplateVars({
      workspace: { name: 'n', workingBranch: 'b', sourceBranch: 's', projectPath: '/p' },
      gitStats: null,
      sessionName: null,
    })
    expect(vars.commit_count).toBeUndefined()
    expect(vars.pr_number).toBeUndefined()
  })

  it('omits PR vars when PR fields are null/undefined', () => {
    const vars = buildTemplateVars({
      workspace: { name: 'n', workingBranch: 'b', sourceBranch: 's', projectPath: '/p' },
      gitStats: {
        commitCount: 0,
        unpushedCount: 0,
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
        prNumber: null,
        prUrl: null,
        prState: null,
      },
      sessionName: null,
    })
    expect(vars.pr_number).toBeUndefined()
    expect(vars.pr_url).toBeUndefined()
    expect(vars.pr_state).toBeUndefined()
    // Non-PR git vars still present
    expect(vars.commit_count).toBe(0)
  })
})
