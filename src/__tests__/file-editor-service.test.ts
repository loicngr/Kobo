import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { saveWorkspaceFile, shaOf } from '../server/services/file-editor-service.js'

let worktree: string

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), 'kobo-file-editor-'))
})

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true })
})

describe('shaOf', () => {
  it('is deterministic', () => {
    expect(shaOf('hello')).toBe(shaOf('hello'))
  })

  it('differs between distinct inputs', () => {
    expect(shaOf('a')).not.toBe(shaOf('b'))
  })
})

describe('saveWorkspaceFile', () => {
  it('writes content when baseSha matches the on-disk file (happy path)', () => {
    writeFileSync(join(worktree, 'a.txt'), 'old')
    const result = saveWorkspaceFile(worktree, 'a.txt', 'new', shaOf('old'))
    expect(result).toEqual({ status: 'saved' })
    expect(readFileSync(join(worktree, 'a.txt'), 'utf-8')).toBe('new')
  })

  it('returns conflict with currentSha when baseSha is stale', () => {
    writeFileSync(join(worktree, 'a.txt'), 'changed-on-disk')
    const result = saveWorkspaceFile(worktree, 'a.txt', 'new', shaOf('what-the-client-thought-was-there'))
    expect(result.status).toBe('conflict')
    if (result.status === 'conflict') {
      expect(result.currentSha).toBe(shaOf('changed-on-disk'))
    }
    expect(readFileSync(join(worktree, 'a.txt'), 'utf-8')).toBe('changed-on-disk')
  })

  it('treats a missing file as empty (baseSha must be shaOf(""))', () => {
    const result = saveWorkspaceFile(worktree, 'new.txt', 'hi', shaOf(''))
    expect(result).toEqual({ status: 'saved' })
    expect(readFileSync(join(worktree, 'new.txt'), 'utf-8')).toBe('hi')
  })

  it('throws on a path that escapes the worktree via `..`', () => {
    expect(() => saveWorkspaceFile(worktree, '../../etc/passwd', 'x', shaOf(''))).toThrow(/escapes the worktree/i)
  })

  it('throws on a symlink that points outside the worktree', () => {
    const outside = mkdtempSync(join(tmpdir(), 'kobo-outside-'))
    try {
      writeFileSync(join(outside, 'target.txt'), 'sensitive')
      symlinkSync(join(outside, 'target.txt'), join(worktree, 'escape.txt'))
      expect(() => saveWorkspaceFile(worktree, 'escape.txt', 'x', shaOf('sensitive'))).toThrow(/escapes the worktree/i)
      expect(readFileSync(join(outside, 'target.txt'), 'utf-8')).toBe('sensitive')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('throws when content exceeds the 1 MB cap', () => {
    writeFileSync(join(worktree, 'a.txt'), '')
    const big = 'x'.repeat(1024 * 1024 + 1)
    expect(() => saveWorkspaceFile(worktree, 'a.txt', big, shaOf(''))).toThrow(/too large/i)
  })

  it('preserves CRLF line endings byte-for-byte', () => {
    writeFileSync(join(worktree, 'a.txt'), 'a\r\nb\r\n')
    const result = saveWorkspaceFile(worktree, 'a.txt', 'c\r\nd\r\n', shaOf('a\r\nb\r\n'))
    expect(result).toEqual({ status: 'saved' })
    expect(readFileSync(join(worktree, 'a.txt'), 'utf-8')).toBe('c\r\nd\r\n')
  })

  it('throws when a parent directory symlinks outside the worktree (missing leaf)', () => {
    const outside = mkdtempSync(join(tmpdir(), 'kobo-outside-'))
    try {
      symlinkSync(outside, join(worktree, 'symdir'))
      expect(() => saveWorkspaceFile(worktree, 'symdir/pwned.txt', 'x', shaOf(''))).toThrow(/escapes the worktree/i)
      expect(existsSync(join(outside, 'pwned.txt'))).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('rejects an absolute path that escapes the worktree', () => {
    expect(() => saveWorkspaceFile(worktree, '/etc/passwd', 'x', shaOf(''))).toThrow(/escapes the worktree/i)
  })
})
