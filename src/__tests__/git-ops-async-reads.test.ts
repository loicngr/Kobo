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

  it('includes committed, staged, unstaged, deleted and untracked files in unpushed changes', async () => {
    repo.commit('delete.txt', 'delete me', 'baseline')
    repo.git(['push', 'origin', 'main'])
    repo.commit('committed.txt', 'local commit', 'not pushed')
    fs.appendFileSync(path.join(repo.path, 'README.md'), 'unstaged change')
    fs.unlinkSync(path.join(repo.path, 'delete.txt'))
    fs.writeFileSync(path.join(repo.path, 'staged.txt'), 'staged')
    repo.git(['add', 'staged.txt'])
    fs.writeFileSync(path.join(repo.path, 'untracked space.txt'), 'untracked')
    fs.writeFileSync(path.join(repo.path, '.git', 'info', 'exclude'), 'ignored.txt\n')
    fs.writeFileSync(path.join(repo.path, 'ignored.txt'), 'ignored')
    const expected = [
      { path: 'README.md', status: 'modified' },
      { path: 'committed.txt', status: 'added' },
      { path: 'delete.txt', status: 'deleted' },
      { path: 'staged.txt', status: 'added' },
      { path: 'untracked space.txt', status: 'untracked' },
    ]
    expect(await git.getUnpushedChangedFilesAsync(repo.path, 'main')).toEqual(expected)
    expect(git.getUnpushedChangedFiles(repo.path, 'main')).toEqual(expected)
  })

  it('compares never-pushed branches with their source branch, including local edits', async () => {
    repo.git(['checkout', '-b', 'feature/new'])
    repo.commit('new.txt', 'local', 'first local commit')
    fs.appendFileSync(path.join(repo.path, 'README.md'), 'local edit')
    const expected = [
      { path: 'README.md', status: 'modified' },
      { path: 'new.txt', status: 'added' },
    ]
    expect(await git.getUnpushedChangedFilesAsync(repo.path, 'feature/new', 'origin', 'main')).toEqual(expected)
    expect(git.getUnpushedChangedFiles(repo.path, 'feature/new', 'origin', 'main')).toEqual(expected)
  })

  it('returns porcelain and diff stats without substituting clean state on errors', async () => {
    fs.appendFileSync(path.join(repo.path, 'README.md'), 'modified\n')
    expect(await git.getWorkingTreePorcelainAsync(repo.path)).toContain('README.md')
    expect(typeof (await git.getWorkingTreeDiffStatsAsync(repo.path))).toBe('string')
    await expect(git.getWorkingTreePorcelainAsync(path.join(repo.path, 'absent'))).rejects.toThrow()
    await expect(git.getWorkingTreeDiffStatsAsync(path.join(repo.path, 'absent'))).rejects.toThrow()
  })
})

describe('strict asynchronous Git reads', () => {
  let repo: TempRepo
  beforeEach(() => {
    repo = createTempRepo()
  })
  afterEach(() => repo.cleanup())

  it('propagates failures instead of reporting an empty, clean diff', async () => {
    const notARepo = fs.mkdtempSync(path.join(path.dirname(repo.path), 'kobo-not-a-repo-'))
    try {
      // Best-effort variants keep their neutral answers for the polling paths.
      expect(await git.getChangedFilesAsync(notARepo, 'main')).toEqual([])
      expect(await git.getWorkingTreeStatusAsync(notARepo)).toEqual({ staged: 0, modified: 0, untracked: 0 })
      await expect(git.getChangedFilesStrictAsync(notARepo, 'main')).rejects.toThrow()
      await expect(git.getWorkingTreeStatusStrictAsync(notARepo)).rejects.toThrow()
      await expect(git.getWorkingTreeFilesStrictAsync(notARepo)).rejects.toThrow()
      await expect(git.getFileAtRefStrictAsync(notARepo, 'HEAD', 'README.md')).rejects.toThrow()
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true })
    }
    await expect(git.getChangedFilesBetweenStrictAsync(repo.path, 'missing-ref', 'HEAD')).rejects.toThrow()
    await expect(git.getCommitsBetweenStrictAsync(repo.path, 'missing-branch', 'HEAD')).rejects.toThrow()
    await expect(git.getDiffStatsBetweenStrictAsync(repo.path, 'missing-branch', 'HEAD')).rejects.toThrow()
  })

  it('keeps the diff usable when the source branch no longer exists locally or on origin', async () => {
    repo.commit('kept.txt', 'old\n', 'kept')
    fs.writeFileSync(path.join(repo.path, 'kept.txt'), 'new\n')
    expect(await git.getChangedFilesStrictAsync(repo.path, 'deleted-after-merge')).toEqual(
      await git.getChangedFilesAsync(repo.path, 'deleted-after-merge'),
    )
    expect(await git.getChangedFilesStrictAsync(repo.path, 'deleted-after-merge')).toEqual([
      { path: 'kept.txt', status: 'modified' },
    ])
    expect(await git.getFileAtRefStrictAsync(repo.path, 'deleted-after-merge', 'kept.txt')).toBeNull()
  })

  it('answers the expected unreadable entries like the best-effort read instead of failing', async () => {
    fs.writeFileSync(path.join(repo.path, ':colon.txt'), 'colon\n')
    repo.git(['add', '-A'])
    repo.git(['commit', '-m', 'leading colon'])
    repo.commit('dir/nested.txt', 'nested\n', 'nested')
    const head = repo.git(['rev-parse', 'HEAD'])
    repo.git(['update-index', '--add', '--cacheinfo', `160000,${head},vendor/sub`])
    repo.git(['commit', '-m', 'gitlink'])
    expect(await git.getFileAtRefStrictAsync(repo.path, 'HEAD', ':colon.txt')).toBe('colon\n')
    expect(await git.getFileAtRefStrictAsync(repo.path, 'HEAD', 'vendor/sub')).toBeNull()
    expect(await git.getFileAtRefStrictAsync(repo.path, 'HEAD', 'dir')).toBeNull()
    expect(await git.getFileAtRefStrictAsync(repo.path, 'HEAD', '*.txt')).toBeNull()
  })

  it('answers null for a blob too large to buffer', async () => {
    repo.commit('small.txt', 'four\n', 'small')
    expect(await git.getFileAtRefStrictAsync(repo.path, 'HEAD', 'small.txt', 2)).toBeNull()
  })

  it.each([
    ['fix/issue#123', true],
    ['feat/été', true],
    ['a+b', true],
    ['x@y', true],
    ['', false],
    ['-x', false],
    ['--upload-pack=x', false],
    ['a b', false],
    ['a\tb', false],
    ['a\u0001b', false],
    ['a..b', false],
    ['a~1', false],
    ['a^', false],
    ['a:b', false],
    ['a?', false],
    ['a*', false],
    ['a[b', false],
    ['a\\b', false],
    ['a.lock', false],
    ['a/', false],
    ['a@{1}', false],
    [42, false],
  ])('isSafeGitRefName(%j) is %s', (name, expected) => {
    expect(git.isSafeGitRefName(name as string)).toBe(expected)
  })

  it('still answers successful reads, and null only for a path absent at the ref', async () => {
    repo.git(['checkout', '-b', 'feature/strict'])
    repo.commit('dir/kept file.txt', '  content\n', 'new file')
    fs.writeFileSync(path.join(repo.path, 'untracked.txt'), 'new\n')
    expect(await git.getChangedFilesStrictAsync(repo.path, 'main', true)).toEqual(
      await git.getChangedFilesAsync(repo.path, 'main', true),
    )
    expect(await git.getFileAtRefStrictAsync(repo.path, 'HEAD', 'dir/kept file.txt')).toBe('  content\n')
    expect(await git.getFileAtRefStrictAsync(repo.path, 'HEAD', 'absent.txt')).toBeNull()
    expect(await git.getFileAtRefStrictAsync(repo.path, git.EMPTY_TREE_SHA, 'dir/kept file.txt')).toBeNull()
    expect(await git.getWorkingTreeStatusStrictAsync(repo.path)).toEqual({ staged: 0, modified: 0, untracked: 1 })
    expect(await git.getWorkingTreeFilesStrictAsync(repo.path)).toEqual(await git.getWorkingTreeFilesAsync(repo.path))
    expect(await git.getCommitsBetweenStrictAsync(repo.path, 'main', 'HEAD')).toContain('new file')
  })
})
