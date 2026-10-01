import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as git from '../server/utils/git-ops.js'
import { createTempRepo, type TempRepo } from './helpers/temp-git-repo.js'

describe('asynchronous interactive Git reads', () => {
  let repo: TempRepo
  beforeEach(() => {
    repo = createTempRepo()
  })
  afterEach(() => repo.cleanup())

  it('keeps original file whitespace and large content', async () => {
    const content = `  first line\n${'a'.repeat(2 * 1024 * 1024)}\n\n`
    repo.commit('large.txt', content, 'large file')
    expect(await git.getFileAtRefAsync(repo.path, 'HEAD', 'large.txt')).toBe(content)
    expect(await git.getFileAtRefAsync(repo.path, 'HEAD', 'absent.txt')).toBeNull()
  })

  it('preserves branch diff and untracked opt-in semantics', async () => {
    repo.git(['checkout', '-b', 'feature/a'])
    repo.commit('committed.txt', 'first\n', 'new file')
    fs.writeFileSync(path.join(repo.path, 'committed.txt'), 'modified\n')
    fs.writeFileSync(path.join(repo.path, 'untracked space.txt'), 'new\n')
    expect(await git.getChangedFilesAsync(repo.path, 'main')).toEqual(git.getChangedFiles(repo.path, 'main'))
    expect(await git.getChangedFilesAsync(repo.path, 'main', true)).toEqual(
      git.getChangedFiles(repo.path, 'main', true),
    )
  })

  it('validates commits and renders historical and unpushed diffs', async () => {
    const before = repo.git(['rev-parse', 'HEAD'])
    repo.commit('new.txt', 'new\n', 'new file')
    expect(await git.commitExistsAsync(repo.path, 'HEAD')).toBe(true)
    expect(await git.commitExistsAsync(repo.path, 'does-not-exist')).toBe(false)
    expect(await git.getChangedFilesBetweenAsync(repo.path, before, 'HEAD')).toEqual([
      { path: 'new.txt', status: 'added' },
    ])
    expect(await git.getUnpushedChangedFilesAsync(repo.path, 'main')).toEqual(
      git.getUnpushedChangedFiles(repo.path, 'main'),
    )
  })

  it('returns porcelain and diff stats without substituting clean state on errors', async () => {
    fs.appendFileSync(path.join(repo.path, 'README.md'), 'modified\n')
    expect(await git.getWorkingTreePorcelainAsync(repo.path)).toContain('README.md')
    expect(typeof (await git.getWorkingTreeDiffStatsAsync(repo.path))).toBe('string')
    await expect(git.getWorkingTreePorcelainAsync(path.join(repo.path, 'absent'))).rejects.toThrow()
    await expect(git.getWorkingTreeDiffStatsAsync(path.join(repo.path, 'absent'))).rejects.toThrow()
  })
})
