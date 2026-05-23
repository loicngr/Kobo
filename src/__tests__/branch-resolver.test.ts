import fs from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/utils/git-ops.js', () => ({
  branchExists: vi.fn(),
}))

vi.mock('../server/utils/worktree-paths.js', () => ({
  resolveWorkspaceWorktreePath: vi.fn((_p: string, branch: string) => `/tmp/.worktrees/${branch}`),
}))

import { resolveUniqueBranchAndPath } from '../server/utils/branch-resolver.js'
import { branchExists } from '../server/utils/git-ops.js'

describe('resolveUniqueBranchAndPath', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the base branch unchanged when neither the path nor the branch exists', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    vi.mocked(branchExists).mockReturnValue(false)

    const result = resolveUniqueBranchAndPath({ projectPath: '/p', baseBranch: 'feature/foo' })

    expect(result.workingBranch).toBe('feature/foo')
    expect(result.worktreePath).toBe('/tmp/.worktrees/feature/foo')
    expect(result.adjusted).toBe(false)
  })

  it('appends a 4-char hash suffix when the on-disk path already exists', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync')
    // First attempt: path taken. All subsequent attempts: free.
    existsSpy.mockReturnValueOnce(true).mockReturnValue(false)
    vi.mocked(branchExists).mockReturnValue(false)

    const result = resolveUniqueBranchAndPath({ projectPath: '/p', baseBranch: 'feature/foo' })

    expect(result.adjusted).toBe(true)
    expect(result.workingBranch).toMatch(/^feature\/foo-[A-Z0-9]{4}$/)
    expect(result.worktreePath).toBe(`/tmp/.worktrees/${result.workingBranch}`)
  })

  it('appends a 4-char hash suffix when the branch exists (path is free)', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    vi.mocked(branchExists)
      .mockImplementationOnce(() => true)
      .mockReturnValue(false)

    const result = resolveUniqueBranchAndPath({ projectPath: '/p', baseBranch: 'feature/foo' })

    expect(result.adjusted).toBe(true)
    expect(result.workingBranch).toMatch(/^feature\/foo-[A-Z0-9]{4}$/)
  })

  it('retries with a fresh hash when the first suffix also collides', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync')
    // base + first suffix taken, then free.
    existsSpy.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false)
    vi.mocked(branchExists).mockReturnValue(false)

    const result = resolveUniqueBranchAndPath({ projectPath: '/p', baseBranch: 'feature/foo' })

    expect(result.adjusted).toBe(true)
    expect(result.workingBranch).toMatch(/^feature\/foo-[A-Z0-9]{4}$/)
    expect(existsSpy).toHaveBeenCalledTimes(3)
  })

  it('throws after 10 collisions in a row', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true) // always taken
    vi.mocked(branchExists).mockReturnValue(false)

    expect(() => resolveUniqueBranchAndPath({ projectPath: '/p', baseBranch: 'feature/foo' })).toThrowError(
      /Failed to find a unique branch/,
    )
  })

  it("treats branchExists throwing as 'branch is free' so the resolver fails open", () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    vi.mocked(branchExists).mockImplementation(() => {
      throw new Error('git is broken')
    })

    const result = resolveUniqueBranchAndPath({ projectPath: '/p', baseBranch: 'feature/foo' })

    expect(result.workingBranch).toBe('feature/foo')
    expect(result.adjusted).toBe(false)
  })
})
