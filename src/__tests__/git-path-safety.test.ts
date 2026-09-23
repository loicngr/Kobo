import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  getChangedFiles,
  getChangedFilesBetween,
  getWorkingTreeFiles,
  listWorktreeFiles,
  rollbackFile,
} from '../server/utils/git-ops.js'

let repo: string
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'kobo-git-paths-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.com')
  writeFileSync(join(repo, 'tracked'), 'original')
  git('add', '.')
  git('commit', '-qm', 'initial')
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

it('preserves tracked contents when checkout cannot acquire the index lock', () => {
  writeFileSync(join(repo, 'tracked'), 'valuable edits')
  writeFileSync(join(repo, '.git/index.lock'), 'owned by another operation')
  expect(() => rollbackFile(repo, 'main', 'tracked')).toThrow()
  expect(readFileSync(join(repo, 'tracked'), 'utf8')).toBe('valuable edits')
})

it('preserves literal filenames and reports the destination of staged renames', () => {
  const destination = 'échec\told -> new\n.txt '
  git('mv', 'tracked', destination)
  const untracked = 'other -> literal\n.txt'
  writeFileSync(join(repo, untracked), 'new')
  expect(getChangedFiles(repo, 'main', true)).toEqual(
    expect.arrayContaining([
      { path: destination, status: 'renamed' },
      { path: untracked, status: 'untracked' },
    ]),
  )
  expect(getWorkingTreeFiles(repo).map((entry) => entry.path)).toEqual(expect.arrayContaining([destination, untracked]))
  expect(listWorktreeFiles(repo)).toEqual(expect.arrayContaining([destination, untracked]))
  git('commit', '-qam', 'rename')
  expect(getChangedFilesBetween(repo, 'HEAD^', 'HEAD')).toEqual([{ path: destination, status: 'renamed' }])
})

it.each(['./tracked', 'directory/../tracked'])('restores tracked contents for normalized path %s', (filePath) => {
  writeFileSync(join(repo, 'tracked'), 'valuable edits')
  expect(rollbackFile(repo, 'main', filePath)).toBe('head')
  expect(readFileSync(join(repo, 'tracked'), 'utf8')).toBe('original')
})

it('restores an absolute path contained in the worktree', () => {
  const filePath = join(repo, 'tracked')
  writeFileSync(filePath, 'valuable edits')
  expect(rollbackFile(repo, 'main', filePath)).toBe('head')
  expect(readFileSync(filePath, 'utf8')).toBe('original')
})

it('removes an untracked symlink without deleting its tracked target', () => {
  symlinkSync('tracked', join(repo, 'alias'))
  expect(rollbackFile(repo, 'main', 'alias')).toBe('deleted')
  expect(existsSync(join(repo, 'alias'))).toBe(false)
  expect(readFileSync(join(repo, 'tracked'), 'utf8')).toBe('original')
})
