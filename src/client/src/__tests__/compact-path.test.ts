import { describe, expect, it } from 'vitest'
import { compactPath } from '../utils/compact-path'

const WS = {
  projectPath: '/home/loicngr/PhpstormProjects/sekur',
  workingBranch: 'feature/r-viser-le-socle',
}

describe('compactPath()', () => {
  it('strips the worktree prefix from a bare file path', () => {
    expect(compactPath(`${WS.projectPath}/.worktrees/${WS.workingBranch}/src/App.tsx`, WS)).toBe('src/App.tsx')
  })

  it('replaces a standalone worktree path with "."', () => {
    expect(compactPath(`find ${WS.projectPath}/.worktrees/${WS.workingBranch} -name "*.ts"`, WS)).toBe(
      'find . -name "*.ts"',
    )
  })

  it('strips multiple occurrences in a shell command', () => {
    const raw = `grep foo ${WS.projectPath}/.worktrees/${WS.workingBranch}/a.ts ${WS.projectPath}/.worktrees/${WS.workingBranch}/b.ts`
    expect(compactPath(raw, WS)).toBe('grep foo a.ts b.ts')
  })

  it('falls back to the project root when the worktree prefix does not match', () => {
    expect(compactPath(`${WS.projectPath}/README.md`, WS)).toBe('README.md')
  })

  it('strips workspace.worktreePath when it is outside the project path', () => {
    const ws = {
      ...WS,
      worktreePath: '/home/loicngr/kobo/worktrees/feature/r-viser-le-socle',
    }

    expect(compactPath(`${ws.worktreePath}/src/App.tsx`, ws)).toBe('src/App.tsx')
  })

  it('strips Windows worktree paths with backslash separators', () => {
    const ws = {
      projectPath: 'C:\\Users\\loic\\Projects\\sekur',
      workingBranch: 'feature/r-viser-le-socle',
      worktreePath: 'C:\\Users\\loic\\kobo\\worktrees\\feature\\r-viser-le-socle',
    }

    expect(compactPath(`type ${ws.worktreePath}\\src\\App.tsx`, ws)).toBe('type src\\App.tsx')
  })

  it('strips legacy Windows worktree paths when worktreePath is absent', () => {
    const ws = {
      projectPath: 'C:\\Users\\loic\\Projects\\sekur',
      workingBranch: 'feature/r-viser-le-socle',
    }

    expect(compactPath(`type C:\\Users\\loic\\Projects\\sekur\\.worktrees\\feature\\r-viser-le-socle\\a.ts`, ws)).toBe(
      'type a.ts',
    )
  })

  it('prefers the worktree prefix over the project root when both could match', () => {
    // Edge: the worktree is a sub-path of projectPath. Make sure the longer
    // (more specific) prefix is matched and stripped fully.
    const raw = `${WS.projectPath}/.worktrees/${WS.workingBranch}/nested/file.ts`
    expect(compactPath(raw, WS)).toBe('nested/file.ts')
  })

  it('leaves unrelated paths unchanged', () => {
    expect(compactPath('/etc/passwd', WS)).toBe('/etc/passwd')
    expect(compactPath('plain text no path', WS)).toBe('plain text no path')
  })

  it('returns the raw string when workspace is null', () => {
    const raw = `${WS.projectPath}/a.ts`
    expect(compactPath(raw, null)).toBe(raw)
    expect(compactPath(raw, undefined)).toBe(raw)
  })

  it('returns an empty string unchanged', () => {
    expect(compactPath('', WS)).toBe('')
  })

  it('handles paths with quotes around them', () => {
    expect(compactPath(`cat "${WS.projectPath}/.worktrees/${WS.workingBranch}/a.ts"`, WS)).toBe('cat "a.ts"')
  })

  it('escapes regex specials in the workspace paths', () => {
    const ws = { projectPath: '/tmp/a+b.c', workingBranch: 'x' }
    expect(compactPath('/tmp/a+b.c/.worktrees/x/file.ts', ws)).toBe('file.ts')
    // A path that happens to match the regex-escaped version but not the literal one MUST NOT be stripped.
    expect(compactPath('/tmp/aXb.c/file.ts', ws)).toBe('/tmp/aXb.c/file.ts')
  })
})
