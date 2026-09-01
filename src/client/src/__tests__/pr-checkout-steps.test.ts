import { describe, expect, it } from 'vitest'
import { defaultDecisions, deriveSteps, type PrCheckoutReport } from '../utils/pr-checkout-steps'

const clean: PrCheckoutReport = {
  projectPath: '/repo',
  headBranch: 'feat/x',
  targetWorktreePath: '/repo/.worktrees/feat-x',
  blockers: [],
  workspace: { state: 'none' },
  worktree: { state: 'none' },
  localChanges: { present: false, modified: 0, staged: 0, untracked: 0 },
  ongoingOperation: null,
  branch: { state: 'absent' },
}

describe('deriveSteps', () => {
  it('renders no step for a clean, brand-new checkout', () => {
    expect(deriveSteps(clean)).toEqual([])
  })

  it('renders a blocking step first and nothing after it', () => {
    const steps = deriveSteps({
      ...clean,
      blockers: [{ kind: 'fork-pr' }],
      worktree: { state: 'orphan', path: '/repo/.worktrees/feat-x' },
    })
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ id: 'blocked', blocking: true })
  })

  it('orders workspace, worktree, changes, then divergence', () => {
    const steps = deriveSteps({
      ...clean,
      workspace: { state: 'active', id: 'w1', name: 'Fix login' },
      worktree: { state: 'orphan', path: '/repo/.worktrees/feat-x' },
      localChanges: { present: true, modified: 2, staged: 0, untracked: 1 },
      branch: { state: 'diverged', ahead: 1, behind: 2 },
    })
    expect(steps.map((s) => s.id)).toEqual(['workspace', 'worktree', 'changes', 'divergence'])
  })

  it('puts the ongoing operation before the changes step', () => {
    const steps = deriveSteps({
      ...clean,
      worktree: { state: 'orphan', path: '/repo/.worktrees/feat-x' },
      ongoingOperation: 'rebase',
      localChanges: { present: true, modified: 1, staged: 0, untracked: 0 },
    })
    expect(steps.map((s) => s.id)).toEqual(['worktree', 'operation', 'changes'])
  })

  it('skips the divergence step when the branch is in sync', () => {
    expect(deriveSteps({ ...clean, branch: { state: 'in-sync' } }).map((s) => s.id)).toEqual([])
  })

  it('offers a path step for an occupied target rather than giving up', () => {
    const steps = deriveSteps({ ...clean, blockers: [{ kind: 'path-occupied', path: '/repo/.worktrees/feat-x' }] })
    expect(steps.map((s) => s.id)).toEqual(['path'])
    expect(steps[0].blocking).toBe(false)
  })

  it('still gives up when a fatal blocker sits alongside a resolvable one', () => {
    const steps = deriveSteps({
      ...clean,
      blockers: [{ kind: 'path-occupied', path: '/x' }, { kind: 'fork-pr' }],
    })
    expect(steps.map((s) => s.id)).toEqual(['blocked'])
  })

  it('does not render a separate worktree step for a purged workspace whose worktree reappeared', () => {
    const steps = deriveSteps({
      ...clean,
      workspace: { state: 'purged', id: 'w1', name: 'Fix login' },
      worktree: { state: 'orphan', path: '/repo/.worktrees/feat-x' },
    })
    expect(steps.map((s) => s.id)).toEqual(['workspace'])
  })
})

describe('defaultDecisions', () => {
  it('never pre-selects an overwrite when local commits exist', () => {
    const d = defaultDecisions({ ...clean, branch: { state: 'diverged', ahead: 3, behind: 1 } })
    expect(d.divergence).toBe('keep')
  })

  it('pre-selects fast-forward when the branch is only behind', () => {
    expect(defaultDecisions({ ...clean, branch: { state: 'behind', behind: 2 } }).divergence).toBe('fast-forward')
  })

  it('pre-selects keeping uncommitted work', () => {
    const d = defaultDecisions({ ...clean, localChanges: { present: true, modified: 1, staged: 0, untracked: 0 } })
    expect(d.localChanges).toBe('keep')
  })

  it('opens an existing active workspace', () => {
    expect(
      defaultDecisions({ ...clean, workspace: { state: 'active', id: 'w1', name: 'Fix login' } }).existingWorkspace,
    ).toBe('open')
  })

  it('unarchives an archived workspace', () => {
    expect(
      defaultDecisions({ ...clean, workspace: { state: 'archived', id: 'w1', name: 'Fix login' } }).archivedWorkspace,
    ).toBe('unarchive')
  })

  it('restores a purged workspace and does not also ask to attach its worktree', () => {
    const d = defaultDecisions({
      ...clean,
      workspace: { state: 'purged', id: 'w1', name: 'Fix login' },
      worktree: { state: 'orphan', path: '/repo/.worktrees/feat-x' },
    })
    expect(d.purgedWorktree).toBe('restore')
    expect(d.orphanWorktree).toBeUndefined()
  })

  it('attaches a plain orphan worktree with no purged workspace behind it', () => {
    const d = defaultDecisions({ ...clean, worktree: { state: 'orphan', path: '/repo/.worktrees/feat-x' } })
    expect(d.orphanWorktree).toBe('attach')
  })

  it('never pre-selects aborting an ongoing operation, since that can discard staged conflict resolution', () => {
    expect(defaultDecisions({ ...clean, ongoingOperation: 'rebase' }).ongoingOperation).toBe('cancel')
  })
})
