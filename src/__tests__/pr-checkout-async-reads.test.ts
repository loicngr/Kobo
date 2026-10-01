import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeFingerprint, diagnoseLocalState } from '../server/services/pr-checkout-service.js'
import * as gitOps from '../server/utils/git-ops.js'
import { createTempRepo, type TempRepo } from './helpers/temp-git-repo.js'

let repo: TempRepo
beforeEach(() => {
  repo = createTempRepo()
})
afterEach(() => {
  vi.restoreAllMocks()
  repo.cleanup()
})

it('diagnoses PR history and worktree state without invoking synchronous Git read helpers', async () => {
  repo.git(['checkout', '-b', 'feature/a'])
  repo.commit('one.txt', 'one\n', 'one')
  repo.git(['push', 'origin', 'feature/a'])
  const synchronousReads = [
    vi.spyOn(gitOps, 'getIndexLockPath'),
    vi.spyOn(gitOps, 'localBranchExists'),
    vi.spyOn(gitOps, 'listRemoteBranches'),
    vi.spyOn(gitOps, 'getWorkingTreeStatus'),
    vi.spyOn(gitOps, 'getOngoingGitOperation'),
    vi.spyOn(gitOps, 'getCommitCount'),
    vi.spyOn(gitOps, 'getCommitsBehind'),
  ]
  const report = await diagnoseLocalState(repo.path, 'feature/a', null)
  expect(report.branch).toEqual({ state: 'in-sync' })
  expect(report.localChanges.present).toBe(false)
  expect(await computeFingerprint(report)).toMatch(/^[a-f0-9]{32}$/)
  for (const read of synchronousReads) expect(read).not.toHaveBeenCalled()
})
