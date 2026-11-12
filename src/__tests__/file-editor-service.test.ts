import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
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
    expect(() => saveWorkspaceFile(worktree, '../../etc/passwd', 'x', shaOf(''))).toThrow(/escapes allowed root/i)
  })

  it('throws on a sibling directory whose name shares the worktree prefix', () => {
    // `/tmp/wt` must NOT treat `/tmp/wt-evil` as inside it — this is exactly
    // what the `+ path.sep` boundary in the lexical containment check guards.
    const escapePath = `../${basename(worktree)}-evil/pwned.txt`
    expect(() => saveWorkspaceFile(worktree, escapePath, 'x', shaOf(''))).toThrow(/escapes allowed root/i)
  })

  it('throws on a symlink that points outside the worktree', () => {
    const outside = mkdtempSync(join(tmpdir(), 'kobo-outside-'))
    try {
      writeFileSync(join(outside, 'target.txt'), 'sensitive')
      symlinkSync(join(outside, 'target.txt'), join(worktree, 'escape.txt'))
      expect(() => saveWorkspaceFile(worktree, 'escape.txt', 'x', shaOf('sensitive'))).toThrow(/escapes allowed root/i)
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
      expect(() => saveWorkspaceFile(worktree, 'symdir/pwned.txt', 'x', shaOf(''))).toThrow(/escapes allowed root/i)
      expect(existsSync(join(outside, 'pwned.txt'))).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('rejects an absolute path that escapes the worktree', () => {
    expect(() => saveWorkspaceFile(worktree, '/etc/passwd', 'x', shaOf(''))).toThrow(/escapes allowed root/i)
  })
})

describe('saveWorkspaceFile overwrite safety', () => {
  it.each([
    ['non UTF-8 bytes', Buffer.from([0x66, 0x6f, 0xff, 0xfe, 0x6f])],
    ['binary content with NUL bytes', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])],
  ])('refuses to overwrite an existing file holding %s', (_label, bytes) => {
    const file = join(worktree, 'data.bin')
    writeFileSync(file, bytes)
    // The sha the client computed from the lossy UTF-8 view must not authorize the write.
    expect(() => saveWorkspaceFile(worktree, 'data.bin', 'text', shaOf(bytes.toString('utf8')))).toThrow(
      /not UTF-8 text/,
    )
    expect(readFileSync(file).equals(bytes)).toBe(true)
  })

  it('refuses to overwrite an existing path it cannot read, instead of treating it as empty', () => {
    mkdirSync(join(worktree, 'folder'))
    expect(() => saveWorkspaceFile(worktree, 'folder', 'text', shaOf(''))).toThrow()
    expect(statSync(join(worktree, 'folder')).isDirectory()).toBe(true)
  })

  it('writes in place: keeps mode and hard links, leaves no temporary file', () => {
    const file = join(worktree, 'run.sh')
    writeFileSync(file, '#!/bin/sh\n')
    chmodSync(file, 0o755)
    linkSync(file, join(worktree, 'hard.sh'))
    const inode = statSync(file).ino
    expect(saveWorkspaceFile(worktree, 'run.sh', '#!/bin/sh\necho ok\n', shaOf('#!/bin/sh\n'))).toEqual({
      status: 'saved',
    })
    expect(readFileSync(join(worktree, 'hard.sh'), 'utf-8')).toBe('#!/bin/sh\necho ok\n')
    expect(statSync(file).mode & 0o777).toBe(0o755)
    expect(statSync(file).ino).toBe(inode)
    expect(readdirSync(worktree).sort()).toEqual(['hard.sh', 'run.sh'])
  })

  it.skipIf(process.getuid?.() === 0)('saves an existing file inside a directory it cannot write to', () => {
    mkdirSync(join(worktree, 'docker-owned'))
    const file = join(worktree, 'docker-owned', 'a.txt')
    writeFileSync(file, 'old')
    chmodSync(join(worktree, 'docker-owned'), 0o555)
    try {
      expect(saveWorkspaceFile(worktree, 'docker-owned/a.txt', 'new', shaOf('old'))).toEqual({ status: 'saved' })
      expect(readFileSync(file, 'utf-8')).toBe('new')
    } finally {
      chmodSync(join(worktree, 'docker-owned'), 0o755)
    }
  })

  it('writes through an in-worktree symlink without replacing the link', () => {
    writeFileSync(join(worktree, 'target.txt'), 'old')
    symlinkSync(join(worktree, 'target.txt'), join(worktree, 'link.txt'))
    saveWorkspaceFile(worktree, 'link.txt', 'new', shaOf('old'))
    expect(readFileSync(join(worktree, 'target.txt'), 'utf-8')).toBe('new')
    expect(readFileSync(join(worktree, 'link.txt'), 'utf-8')).toBe('new')
  })
})
