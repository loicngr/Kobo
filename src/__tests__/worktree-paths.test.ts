import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  normalizeWorktreesPath,
  resolveSiblingWorkspaceWorktreePath,
  resolveWorkspaceWorktreePath,
  resolveWorktreesRoot,
  sanitizeWorktreesPath,
  validateWorktreesPath,
} from '../server/utils/worktree-paths.js'

const originalHome = process.env.HOME
const originalUserProfile = process.env.USERPROFILE

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = originalUserProfile
})

describe('worktree path helpers', () => {
  it('keeps .worktrees as the default path', () => {
    expect(normalizeWorktreesPath(undefined)).toBe('.worktrees')
    expect(normalizeWorktreesPath('   ')).toBe('.worktrees')
    expect(resolveWorkspaceWorktreePath('/repo', 'feature/x')).toBe(path.resolve('/repo', '.worktrees', 'feature/x'))
  })

  it('resolves relative worktrees roots from the project path', () => {
    expect(resolveWorkspaceWorktreePath('/repo', 'feature/x', 'custom-worktrees')).toBe(
      path.resolve('/repo', 'custom-worktrees', 'feature/x'),
    )
  })

  it('supports absolute worktrees roots', () => {
    expect(resolveWorkspaceWorktreePath('/repo', 'feature/x', '/var/kobo/worktrees')).toBe(
      path.join('/var/kobo/worktrees', 'feature/x'),
    )
  })

  it('expands HOME aliases in worktrees roots', () => {
    process.env.HOME = '/home/tester'
    const bracedHome = '$' + '{HOME}'

    expect(resolveWorktreesRoot('/repo', '$HOME/kobo/worktress')).toBe('/home/tester/kobo/worktress')
    expect(resolveWorktreesRoot('/repo', `${bracedHome}/kobo/worktrees`)).toBe('/home/tester/kobo/worktrees')
    expect(resolveWorktreesRoot('/repo', '~/kobo/worktrees')).toBe('/home/tester/kobo/worktrees')
    expect(resolveWorktreesRoot('/repo', '~\\kobo\\worktrees')).toBe('/home/tester/kobo/worktrees')
  })

  it('expands USERPROFILE aliases with Windows-style roots', () => {
    delete process.env.HOME
    process.env.USERPROFILE = 'C:\\Users\\tester'

    expect(resolveWorktreesRoot('C:\\repo', '%USERPROFILE%\\kobo\\worktrees')).toBe(
      path.win32.join('C:\\Users\\tester', 'kobo', 'worktrees'),
    )
    expect(resolveWorktreesRoot('C:\\repo', '$HOME/kobo/worktrees')).toBe(
      path.win32.join('C:\\Users\\tester', 'kobo', 'worktrees'),
    )
  })

  it('resolves Windows project-relative and absolute worktrees roots', () => {
    expect(resolveWorkspaceWorktreePath('C:\\repo', 'feature/x')).toBe(
      path.win32.resolve('C:\\repo', '.worktrees', 'feature/x'),
    )
    expect(resolveWorkspaceWorktreePath('C:\\repo', 'feature/x', 'custom\\worktrees')).toBe(
      path.win32.resolve('C:\\repo', 'custom\\worktrees', 'feature/x'),
    )
    expect(resolveWorkspaceWorktreePath('C:\\repo', 'feature/x', 'D:\\kobo\\worktrees')).toBe(
      path.win32.join('D:\\kobo\\worktrees', 'feature/x'),
    )
  })

  it('accepts Unix and Windows absolute, relative, and HOME-prefixed paths', () => {
    const bracedHome = '$' + '{HOME}'

    expect(validateWorktreesPath('/var/kobo/worktrees')).toBe('/var/kobo/worktrees')
    expect(validateWorktreesPath('kobo/worktrees')).toBe('kobo/worktrees')
    expect(validateWorktreesPath('C:\\kobo\\worktrees')).toBe('C:\\kobo\\worktrees')
    expect(validateWorktreesPath('C:/kobo/worktrees')).toBe('C:/kobo/worktrees')
    expect(validateWorktreesPath('kobo\\worktrees')).toBe('kobo\\worktrees')
    expect(validateWorktreesPath('\\\\server\\share\\worktrees')).toBe('\\\\server\\share\\worktrees')
    expect(validateWorktreesPath('$HOME/kobo/worktrees')).toBe('$HOME/kobo/worktrees')
    expect(validateWorktreesPath(`${bracedHome}/kobo/worktrees`)).toBe(`${bracedHome}/kobo/worktrees`)
    expect(validateWorktreesPath('~/kobo/worktrees')).toBe('~/kobo/worktrees')
    expect(validateWorktreesPath('%USERPROFILE%\\kobo\\worktrees')).toBe('%USERPROFILE%\\kobo\\worktrees')
  })

  it('rejects traversal and unsafe worktrees paths', () => {
    expect(() => validateWorktreesPath('../outside')).toThrow(/parent directory traversal/)
    expect(() => validateWorktreesPath('foo/../outside')).toThrow(/parent directory traversal/)
    expect(() => validateWorktreesPath('foo\\..\\outside')).toThrow(/parent directory traversal/)
    expect(() => validateWorktreesPath('/tmp/../outside')).toThrow(/parent directory traversal/)
    expect(() => validateWorktreesPath('C:\\tmp\\..\\outside')).toThrow(/parent directory traversal/)
    expect(() => validateWorktreesPath('$HOME/../outside')).toThrow(/parent directory traversal/)
    expect(() => validateWorktreesPath('%USERPROFILE%\\..\\outside')).toThrow(/parent directory traversal/)
    expect(() => validateWorktreesPath('C:worktrees')).toThrow(/Windows drive paths/)
    expect(() => validateWorktreesPath('foo\nbar')).toThrow(/control characters/)
  })

  it('resolves renamed workspace worktrees beside the current POSIX path', () => {
    expect(
      resolveSiblingWorkspaceWorktreePath(
        '/repo',
        '/var/kobo/worktrees/feature/old-name',
        'feature/old-name',
        'feature/new-name',
      ),
    ).toBe('/var/kobo/worktrees/feature/new-name')
  })

  it('resolves renamed workspace worktrees beside the current Windows path', () => {
    expect(
      resolveSiblingWorkspaceWorktreePath(
        'C:\\repo',
        'D:\\kobo\\worktrees\\feature\\old-name',
        'feature/old-name',
        'feature/new-name',
      ),
    ).toBe(path.win32.join('D:\\kobo\\worktrees', 'feature/new-name'))
  })

  it('falls back to the default root when the current path no longer matches the branch', () => {
    expect(resolveSiblingWorkspaceWorktreePath('/repo', '/tmp/already-renamed', 'feature/old', 'feature/new')).toBe(
      path.resolve('/repo', '.worktrees', 'feature/new'),
    )
  })

  it('sanitizes invalid persisted values back to the default', () => {
    expect(sanitizeWorktreesPath('../outside')).toBe('.worktrees')
    expect(sanitizeWorktreesPath('safe/worktrees')).toBe('safe/worktrees')
  })
})
