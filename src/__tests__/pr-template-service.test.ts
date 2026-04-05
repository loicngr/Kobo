import { describe, expect, it } from 'vitest'
import { renderPrTemplate } from '../server/services/pr-template-service.js'
import type { Task, Workspace } from '../server/services/workspace-service.js'

const baseWorkspace: Workspace = {
  id: 'ws-1',
  name: 'Add auth flow',
  projectPath: '/home/user/projects/orion',
  sourceBranch: 'develop',
  workingBranch: 'feature/auth',
  status: 'executing',
  notionUrl: 'https://notion.so/abc',
  notionPageId: 'abc',
  model: 'claude-opus-4-6',
  devServerStatus: 'stopped',
  createdAt: '2026-04-05T10:00:00.000Z',
  updatedAt: '2026-04-05T10:00:00.000Z',
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `t-${Math.random()}`,
    workspaceId: 'ws-1',
    title: 'task',
    status: 'pending',
    isAcceptanceCriterion: false,
    sortOrder: 0,
    createdAt: '2026-04-05T10:00:00.000Z',
    updatedAt: '2026-04-05T10:00:00.000Z',
    ...overrides,
  }
}

describe('renderPrTemplate', () => {
  it('substitutes pr_number and pr_url', () => {
    const out = renderPrTemplate('PR #{{pr_number}} at {{pr_url}}', {
      workspace: baseWorkspace,
      prNumber: 42,
      prUrl: 'https://github.com/org/repo/pull/42',
      commits: '',
      diffStats: '',
      tasks: [],
    })
    expect(out).toBe('PR #42 at https://github.com/org/repo/pull/42')
  })

  it('substitutes branch_name and source_branch', () => {
    const out = renderPrTemplate('{{branch_name}} → {{source_branch}}', {
      workspace: baseWorkspace,
      prNumber: 1,
      prUrl: '',
      commits: '',
      diffStats: '',
      tasks: [],
    })
    expect(out).toBe('feature/auth → develop')
  })

  it('substitutes workspace_name and project_name', () => {
    const out = renderPrTemplate('{{workspace_name}} in {{project_name}}', {
      workspace: baseWorkspace,
      prNumber: 1,
      prUrl: '',
      commits: '',
      diffStats: '',
      tasks: [],
    })
    expect(out).toBe('Add auth flow in orion')
  })

  it('substitutes notion_url when defined', () => {
    const out = renderPrTemplate('Notion: {{notion_url}}', {
      workspace: baseWorkspace,
      prNumber: 1,
      prUrl: '',
      commits: '',
      diffStats: '',
      tasks: [],
    })
    expect(out).toBe('Notion: https://notion.so/abc')
  })

  it('substitutes notion_url with empty string when null', () => {
    const out = renderPrTemplate('Notion: {{notion_url}}', {
      workspace: { ...baseWorkspace, notionUrl: null },
      prNumber: 1,
      prUrl: '',
      commits: '',
      diffStats: '',
      tasks: [],
    })
    expect(out).toBe('Notion: ')
  })

  it('substitutes commits and diff_stats', () => {
    const out = renderPrTemplate('Commits:\n{{commits}}\n\nStats: {{diff_stats}}', {
      workspace: baseWorkspace,
      prNumber: 1,
      prUrl: '',
      commits: '- feat: a\n- fix: b',
      diffStats: '2 files changed, 5 insertions(+), 1 deletion(-)',
      tasks: [],
    })
    expect(out).toContain('- feat: a')
    expect(out).toContain('2 files changed')
  })

  it('formats tasks with done/pending checkboxes and filters out criteria', () => {
    const tasks = [
      makeTask({ title: 'Task A', status: 'done', isAcceptanceCriterion: false }),
      makeTask({ title: 'Task B', status: 'pending', isAcceptanceCriterion: false }),
      makeTask({ title: 'Criterion X', status: 'done', isAcceptanceCriterion: true }),
    ]
    const out = renderPrTemplate('{{tasks}}', {
      workspace: baseWorkspace,
      prNumber: 1,
      prUrl: '',
      commits: '',
      diffStats: '',
      tasks,
    })
    expect(out).toBe('- [x] Task A\n- [ ] Task B')
  })

  it('formats acceptance_criteria with checkboxes and filters out regular tasks', () => {
    const tasks = [
      makeTask({ title: 'Task A', status: 'done', isAcceptanceCriterion: false }),
      makeTask({ title: 'Criterion X', status: 'done', isAcceptanceCriterion: true }),
      makeTask({ title: 'Criterion Y', status: 'pending', isAcceptanceCriterion: true }),
    ]
    const out = renderPrTemplate('{{acceptance_criteria}}', {
      workspace: baseWorkspace,
      prNumber: 1,
      prUrl: '',
      commits: '',
      diffStats: '',
      tasks,
    })
    expect(out).toBe('- [x] Criterion X\n- [ ] Criterion Y')
  })

  it('leaves unknown variables intact', () => {
    const out = renderPrTemplate('Known: {{pr_number}}, unknown: {{custom_var}}', {
      workspace: baseWorkspace,
      prNumber: 42,
      prUrl: '',
      commits: '',
      diffStats: '',
      tasks: [],
    })
    expect(out).toBe('Known: 42, unknown: {{custom_var}}')
  })

  it('leaves template unchanged when no placeholders present', () => {
    const out = renderPrTemplate('Just plain text.', {
      workspace: baseWorkspace,
      prNumber: 1,
      prUrl: '',
      commits: '',
      diffStats: '',
      tasks: [],
    })
    expect(out).toBe('Just plain text.')
  })

  it('renders the full default template end to end', () => {
    const template = `A pull request has been opened: {{pr_url}} (#{{pr_number}})

Workspace: {{workspace_name}}
Project: {{project_name}}
Branch: {{branch_name}} → {{source_branch}}

{{diff_stats}}

{{commits}}

{{tasks}}

{{acceptance_criteria}}`

    const tasks = [
      makeTask({ title: 'Setup', status: 'done' }),
      makeTask({ title: 'Tests', status: 'pending' }),
      makeTask({ title: 'User can log in', isAcceptanceCriterion: true, status: 'done' }),
    ]

    const out = renderPrTemplate(template, {
      workspace: baseWorkspace,
      prNumber: 42,
      prUrl: 'https://github.com/org/repo/pull/42',
      commits: '- feat: add auth (abc123)',
      diffStats: '3 files changed, 50 insertions(+), 5 deletions(-)',
      tasks,
    })

    expect(out).toContain('https://github.com/org/repo/pull/42 (#42)')
    expect(out).toContain('Workspace: Add auth flow')
    expect(out).toContain('Project: orion')
    expect(out).toContain('feature/auth → develop')
    expect(out).toContain('3 files changed')
    expect(out).toContain('- feat: add auth (abc123)')
    expect(out).toContain('- [x] Setup')
    expect(out).toContain('- [ ] Tests')
    expect(out).toContain('- [x] User can log in')
    expect(out).not.toContain('{{')
  })
})
