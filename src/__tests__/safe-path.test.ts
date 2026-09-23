import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertPathInside,
  isPathInside,
  resolveExistingPathInside,
  resolvePathInside,
} from '../server/utils/safe-path.js'

// This module is what keeps the file-editing routes inside the worktree. It is
// pure, tiny, and was the highest risk-per-line untested file in the repo.
let root: string
let outside: string

beforeEach(() => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-safe-path-')))
  root = path.join(base, 'worktree')
  outside = path.join(base, 'elsewhere')
  fs.mkdirSync(root)
  fs.mkdirSync(outside)
})

afterEach(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true })
})

describe('isPathInside', () => {
  it('accepts the root itself and anything under it', () => {
    expect(isPathInside(root, root)).toBe(true)
    expect(isPathInside(root, path.join(root, 'a', 'b.txt'))).toBe(true)
  })

  it('rejects a sibling, a parent, and a lookalike prefix', () => {
    expect(isPathInside(root, outside)).toBe(false)
    expect(isPathInside(root, path.dirname(root))).toBe(false)
    // `worktree-evil` shares the prefix but is not inside `worktree`.
    expect(isPathInside(root, `${root}-evil`)).toBe(false)
  })
})

describe('assertPathInside', () => {
  it('accepts a plain relative path', () => {
    expect(() => assertPathInside(root, 'src/index.ts')).not.toThrow()
  })

  it('rejects traversal and absolute paths', () => {
    expect(() => assertPathInside(root, '../elsewhere/x')).toThrow(/escapes/)
    expect(() => assertPathInside(root, '/etc/passwd')).toThrow(/escapes/)
    expect(() => assertPathInside(root, 'a/../../b')).toThrow(/escapes/)
  })
})

describe('resolveExistingPathInside', () => {
  it('follows a symlink and rejects it when the target is outside', () => {
    const target = path.join(outside, 'secret.txt')
    fs.writeFileSync(target, 'x')
    const link = path.join(root, 'link.txt')
    fs.symlinkSync(target, link)

    expect(() => resolveExistingPathInside(root, link)).toThrow(/escapes/)
  })

  it('accepts a symlink whose target stays inside', () => {
    const target = path.join(root, 'real.txt')
    fs.writeFileSync(target, 'x')
    const link = path.join(root, 'link.txt')
    fs.symlinkSync(target, link)

    expect(resolveExistingPathInside(root, link)).toBe(fs.realpathSync(target))
  })
})

describe('resolvePathInside', () => {
  it('allows a missing leaf, which is how a new file gets created', () => {
    expect(resolvePathInside(root, 'new-file.txt')).toBe(path.join(root, 'new-file.txt'))
  })

  it('rejects a path whose parent directory is a symlink pointing out', () => {
    const linkedDir = path.join(root, 'linked')
    fs.symlinkSync(outside, linkedDir)

    expect(() => resolvePathInside(root, 'linked/file.txt')).toThrow(/escapes/)
  })

  it('rejects a DANGLING symlink pointing outside the root', () => {
    // The leaf does not exist, so the realpath check gives up with ENOENT and
    // the unresolved path used to be returned as-is. writeFileSync then follows
    // the link on O_CREAT and creates the file outside the worktree — a repo
    // that ships `notes.md -> ~/.bashrc.d/x.sh` gets a write on the next save.
    const link = path.join(root, 'notes.md')
    fs.symlinkSync(path.join(outside, 'does-not-exist-yet.sh'), link)

    expect(() => resolvePathInside(root, 'notes.md')).toThrow(/escapes/)
  })
})
