import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { fingerprintWorktree } from '../server/utils/git-worktree-fingerprint.js'
import { createTempRepo, type TempRepo } from './helpers/temp-git-repo.js'

let repo: TempRepo
beforeEach(() => {
  repo = createTempRepo()
})
afterEach(() => repo.cleanup())

it('detects same-size binary and executable-mode changes in tracked files', async () => {
  const file = path.join(repo.path, 'binary')
  fs.writeFileSync(file, Buffer.from([0, 1, 2]))
  repo.git(['add', 'binary'])
  repo.git(['commit', '-m', 'binary'])
  fs.writeFileSync(file, Buffer.from([0, 1, 3]))
  const dirty = await fingerprintWorktree(repo.path)
  fs.writeFileSync(file, Buffer.from([0, 1, 4]))
  const changed = await fingerprintWorktree(repo.path)
  expect(changed).not.toBe(dirty)
  fs.chmodSync(file, 0o755)
  expect(await fingerprintWorktree(repo.path)).not.toBe(changed)
})

it('is stable for unchanged content and ignores excluded build files', async () => {
  repo.commit('.gitignore', 'build/\n', 'ignore build')
  fs.writeFileSync(path.join(repo.path, 'z.txt'), 'z')
  fs.writeFileSync(path.join(repo.path, 'a.txt'), 'a')
  const before = await fingerprintWorktree(repo.path)
  fs.mkdirSync(path.join(repo.path, 'build'))
  fs.writeFileSync(path.join(repo.path, 'build', 'ignored'), 'ignored')
  expect(await fingerprintWorktree(repo.path)).toBe(before)
  fs.renameSync(path.join(repo.path, 'a.txt'), path.join(repo.path, 'b.txt'))
  expect(await fingerprintWorktree(repo.path)).not.toBe(before)
})

it('hashes a large untracked file incrementally and symlink text independently of its target', async () => {
  const file = path.join(repo.path, 'large')
  fs.writeFileSync(file, Buffer.alloc(8 * 1024 * 1024, 1))
  fs.symlinkSync('/nonexistent-external-target', path.join(repo.path, 'link'))
  const before = await fingerprintWorktree(repo.path)
  const fd = fs.openSync(file, 'r+')
  fs.writeSync(fd, Buffer.from([2]), 0, 1, 7 * 1024 * 1024)
  fs.closeSync(fd)
  expect(await fingerprintWorktree(repo.path)).not.toBe(before)
})

function initNested(relativePath = 'nested'): string {
  const nested = path.join(repo.path, relativePath)
  fs.mkdirSync(nested, { recursive: true })
  repo.git(['init', '--initial-branch=main'], nested)
  return nested
}

it('fingerprints an unborn nested repository deterministically and detects its untracked content', async () => {
  const nested = initNested()
  const empty = await fingerprintWorktree(repo.path)
  expect(await fingerprintWorktree(repo.path)).toBe(empty)
  fs.writeFileSync(path.join(nested, 'local.txt'), 'first')
  const first = await fingerprintWorktree(repo.path)
  expect(first).not.toBe(empty)
  fs.writeFileSync(path.join(nested, 'local.txt'), 'other')
  expect(await fingerprintWorktree(repo.path)).not.toBe(first)
})

it('includes nested HEAD, staged changes and unstaged changes', async () => {
  const nested = initNested()
  const tracked = path.join(nested, 'tracked.txt')
  fs.writeFileSync(tracked, 'base')
  repo.git(['add', '.'], nested)
  repo.git(['commit', '-m', 'base'], nested)
  const clean = await fingerprintWorktree(repo.path)
  repo.git(['commit', '--allow-empty', '-m', 'new HEAD, same files'], nested)
  const committed = await fingerprintWorktree(repo.path)
  expect(committed).not.toBe(clean)
  fs.writeFileSync(tracked, 'next')
  const unstaged = await fingerprintWorktree(repo.path)
  expect(unstaged).not.toBe(committed)
  repo.git(['add', '.'], nested)
  const staged = await fingerprintWorktree(repo.path)
  expect(staged).not.toBe(unstaged)
  fs.writeFileSync(tracked, 'last')
  expect(await fingerprintWorktree(repo.path)).not.toBe(staged)
})

it('recurses into deeper repositories while excluding ignored files and Git metadata', async () => {
  const nested = initNested()
  fs.writeFileSync(path.join(nested, '.gitignore'), 'build/\n')
  const deeper = initNested('nested/deeper')
  const before = await fingerprintWorktree(repo.path)
  fs.mkdirSync(path.join(nested, 'build'))
  fs.writeFileSync(path.join(nested, 'build', 'ignored.txt'), 'ignored')
  fs.writeFileSync(path.join(nested, '.git', 'fingerprint-sentinel'), 'not worktree content')
  expect(await fingerprintWorktree(repo.path)).toBe(before)
  fs.writeFileSync(path.join(deeper, 'local.txt'), 'deep work')
  expect(await fingerprintWorktree(repo.path)).not.toBe(before)
})

it('hashes nested symlink text without following an external target or a parent cycle', async () => {
  const nested = initNested()
  const outside = path.join(repo.originPath, 'outside.txt')
  fs.writeFileSync(outside, 'first')
  fs.symlinkSync(outside, path.join(nested, 'external'))
  fs.symlinkSync(repo.path, path.join(nested, 'parent'))
  const before = await fingerprintWorktree(repo.path)
  fs.writeFileSync(outside, 'other')
  expect(await fingerprintWorktree(repo.path)).toBe(before)
  fs.unlinkSync(path.join(nested, 'external'))
  fs.symlinkSync(`${outside}-missing`, path.join(nested, 'external'))
  expect(await fingerprintWorktree(repo.path)).not.toBe(before)
})
