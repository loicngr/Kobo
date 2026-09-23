import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  computeFingerprint,
  diagnoseLocalState,
  resolveWorkspaceState,
} from '../server/services/pr-checkout-service.js'
import { resolveWorkspaceWorktreePath } from '../server/utils/worktree-paths.js'
import { createTempRepo, type TempRepo } from './helpers/temp-git-repo.js'

describe('diagnoseLocalState', () => {
  let repo: TempRepo
  beforeEach(() => {
    repo = createTempRepo()
  })
  afterEach(() => repo.cleanup())

  it('reports an absent branch when nothing local matches', async () => {
    const report = await diagnoseLocalState(repo.path, 'feat/new', null)
    expect(report.branch).toEqual({ state: 'absent' })
    expect(report.worktree).toEqual({ state: 'none' })
    expect(report.localChanges.present).toBe(false)
  })

  it('reports in-sync when the local branch matches origin', async () => {
    repo.git(['checkout', '-b', 'feat/x'])
    repo.commit('a.txt', 'a\n', 'feat: a')
    repo.git(['push', '-u', 'origin', 'feat/x'])
    expect((await diagnoseLocalState(repo.path, 'feat/x', null)).branch).toEqual({ state: 'in-sync' })
  })

  it('reports how far behind the local branch is', async () => {
    repo.git(['checkout', '-b', 'feat/y'])
    repo.commit('b.txt', 'b\n', 'feat: b')
    repo.git(['push', '-u', 'origin', 'feat/y'])
    repo.commit('c.txt', 'c\n', 'feat: c')
    repo.git(['push', 'origin', 'feat/y'])
    repo.git(['reset', '--hard', 'HEAD~1'])
    expect((await diagnoseLocalState(repo.path, 'feat/y', null)).branch).toEqual({ state: 'behind', behind: 1 })
  })

  it('reports unpushed commits as ahead', async () => {
    repo.git(['checkout', '-b', 'feat/z'])
    repo.commit('d.txt', 'd\n', 'feat: d')
    repo.git(['push', '-u', 'origin', 'feat/z'])
    repo.commit('e.txt', 'e\n', 'feat: e')
    expect((await diagnoseLocalState(repo.path, 'feat/z', null)).branch).toEqual({ state: 'ahead', ahead: 1 })
  })

  it('reports a divergence with both counts', async () => {
    repo.git(['checkout', '-b', 'feat/w'])
    repo.commit('f.txt', 'f\n', 'feat: f')
    repo.git(['push', '-u', 'origin', 'feat/w'])
    repo.commit('g.txt', 'g\n', 'feat: g')
    repo.git(['push', 'origin', 'feat/w'])
    repo.git(['reset', '--hard', 'HEAD~1'])
    repo.commit('h.txt', 'h\n', 'feat: h')
    expect((await diagnoseLocalState(repo.path, 'feat/w', null)).branch).toEqual({
      state: 'diverged',
      ahead: 1,
      behind: 1,
    })
  })

  it('flags a target path already occupied by a non-worktree directory', async () => {
    const busy = resolveWorkspaceWorktreePath(repo.path, 'feat/busy', null)
    fs.mkdirSync(busy, { recursive: true })
    fs.writeFileSync(path.join(busy, 'stray.txt'), 'x')
    const report = await diagnoseLocalState(repo.path, 'feat/busy', null)
    expect(report.blockers.some((b) => b.kind === 'path-occupied')).toBe(true)
  })

  it('detects an ongoing operation and a dirty tree in an existing worktree', async () => {
    repo.git(['checkout', '-b', 'feat/dirty'])
    repo.commit('i.txt', 'i\n', 'feat: i')
    repo.git(['push', '-u', 'origin', 'feat/dirty'])
    repo.git(['checkout', 'main'])
    const wt = path.join(repo.path, '.worktrees', 'feat-dirty')
    repo.git(['worktree', 'add', wt, 'feat/dirty'])
    fs.writeFileSync(path.join(wt, 'i.txt'), 'changed\n')
    fs.writeFileSync(path.join(wt, 'new.txt'), 'new\n')
    const report = await diagnoseLocalState(repo.path, 'feat/dirty', null)
    expect(report.worktree.state).toBe('orphan')
    expect(report.localChanges).toMatchObject({ present: true, modified: 1, untracked: 1 })
    expect(report.ongoingOperation).toBeNull()
  })

  it('does not flag no-common-ancestor for an ordinary unpushed local branch', async () => {
    repo.git(['checkout', '-b', 'feat/local-only'])
    repo.commit('j.txt', 'j\n', 'feat: j')
    const report = await diagnoseLocalState(repo.path, 'feat/local-only', null)
    expect(report.branch).toEqual({ state: 'in-sync' })
    expect(report.blockers.some((b) => b.kind === 'no-common-ancestor')).toBe(false)
  })

  it('still flags a genuine no-common-ancestor collision', async () => {
    // Push an orphan-history branch to origin under the target name.
    repo.git(['checkout', '--orphan', 'feat/collision'])
    repo.git(['reset', '--hard'])
    repo.commit('unrelated.txt', 'x\n', 'chore: unrelated history')
    repo.git(['push', 'origin', 'feat/collision'])
    // Now recreate a local branch of the SAME name from main's history instead.
    repo.git(['checkout', 'main'])
    repo.git(['branch', '-D', 'feat/collision'])
    repo.git(['checkout', '-b', 'feat/collision'])
    repo.commit('local.txt', 'y\n', 'feat: local history')
    const report = await diagnoseLocalState(repo.path, 'feat/collision', null)
    expect(report.blockers.some((b) => b.kind === 'no-common-ancestor')).toBe(true)
  })
})

describe('resolveWorkspaceState', () => {
  const base = {
    projectPath: '/repo',
    id: 'w1',
    name: 'Fix login',
    workingBranch: 'fix/login',
    archivedAt: null,
    worktreePurgedAt: null,
  }

  it('reports none when no workspace tracks the branch', async () => {
    expect(resolveWorkspaceState([], 'fix/login', '/repo')).toEqual({ state: 'none' })
  })

  it('reports an active workspace', async () => {
    expect(resolveWorkspaceState([base], 'fix/login', '/repo')).toEqual({
      state: 'active',
      id: 'w1',
      name: 'Fix login',
    })
  })

  it('reports an archived workspace', async () => {
    const archived = { ...base, archivedAt: '2026-08-01T00:00:00Z' }
    expect(resolveWorkspaceState([archived], 'fix/login', '/repo')).toEqual({
      state: 'archived',
      id: 'w1',
      name: 'Fix login',
    })
  })

  it('reports a purged worktree ahead of the archived flag', async () => {
    const purged = { ...base, archivedAt: '2026-08-01T00:00:00Z', worktreePurgedAt: '2026-08-02T00:00:00Z' }
    expect(resolveWorkspaceState([purged], 'fix/login', '/repo')).toEqual({
      state: 'purged',
      id: 'w1',
      name: 'Fix login',
    })
  })
})

describe('computeFingerprint', () => {
  let repo: TempRepo
  beforeEach(() => {
    repo = createTempRepo()
  })
  afterEach(() => repo.cleanup())

  it('is stable across two diagnoses of an unchanged repository', async () => {
    const a = await diagnoseLocalState(repo.path, 'feat/fp', null)
    const b = await diagnoseLocalState(repo.path, 'feat/fp', null)
    expect(await computeFingerprint(a)).toBe(await computeFingerprint(b))
  })

  it('changes when the branch advances', async () => {
    repo.git(['checkout', '-b', 'feat/fp'])
    repo.commit('a.txt', 'a\n', 'feat: a')
    const before = await computeFingerprint(await diagnoseLocalState(repo.path, 'feat/fp', null))
    repo.commit('b.txt', 'b\n', 'feat: b')
    expect(await computeFingerprint(await diagnoseLocalState(repo.path, 'feat/fp', null))).not.toBe(before)
  })

  it('changes when the tracked workspace state changes', async () => {
    const withoutWorkspace = await diagnoseLocalState(repo.path, 'feat/fp2', null)
    const before = await computeFingerprint(withoutWorkspace)
    const active = {
      projectPath: repo.path,
      id: 'w1',
      name: 'Test',
      workingBranch: 'feat/fp2',
      archivedAt: null,
      worktreePurgedAt: null,
    }
    const withWorkspace = await diagnoseLocalState(repo.path, 'feat/fp2', null, new Map(), [active])
    expect(await computeFingerprint(withWorkspace)).not.toBe(before)
  })
})

it('matches workspaces by project as well as branch', async () => {
  const a = {
    id: 'a',
    name: 'A',
    projectPath: '/project/a',
    workingBranch: 'fix/login',
    archivedAt: null,
    worktreePurgedAt: null,
  }
  const b = { ...a, id: 'b', name: 'B', projectPath: '/project/b' }
  expect(resolveWorkspaceState([a, b], 'fix/login', '/project/b/')).toEqual({ state: 'active', id: 'b', name: 'B' })
  expect(resolveWorkspaceState([a], 'fix/login', '/project/b')).toEqual({ state: 'none' })
})
