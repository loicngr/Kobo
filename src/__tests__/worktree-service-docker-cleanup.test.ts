import { execFileSync } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn(), execFile: vi.fn() }))

import { removeWorktree } from '../server/services/worktree-service.js'

const mockExec = vi.mocked(execFileSync)

// worktree path intentionally NOT under the project dir, so removeFromExclude no-ops (no real fs).
const PROJECT = '/tmp/proj'
const WORKTREE = '/tmp/other/ws'

beforeEach(() => {
  mockExec.mockReset()
})

describe('removeWorktree Docker cleanup', () => {
  it('happy path: git remove succeeds, Docker is never invoked', () => {
    mockExec.mockReturnValue('' as never)
    removeWorktree(PROJECT, WORKTREE)
    expect(mockExec.mock.calls.filter((c) => c[0] === 'docker')).toHaveLength(0)
  })

  it('recovers from a permission error (French locale message) via Docker chown then prune', () => {
    mockExec.mockImplementation(((file: string, args?: readonly string[]) => {
      if (file === 'docker') return ''
      // The first `git worktree remove` already de-registered the worktree, so the
      // recovery uses fs.rmSync + `git worktree prune`, never a second remove.
      // The real-world failure: a French host reports "Permission non accordée".
      if (file === 'git' && args?.includes('remove')) {
        throw new Error("erreur : échec de la suppression de '/tmp/other/ws': Permission non accordée")
      }
      return ''
    }) as unknown as typeof execFileSync)

    expect(() => removeWorktree(PROJECT, WORKTREE)).not.toThrow()
    // git is invoked under the C locale so its errors are deterministic English.
    const gitCall = mockExec.mock.calls.find((c) => c[0] === 'git')
    expect((gitCall?.[2] as { env?: Record<string, string> })?.env?.LC_ALL).toBe('C')
    // Docker chown reclaimed ownership…
    const dockerRun = mockExec.mock.calls.find((c) => c[0] === 'docker' && (c[1] as string[])?.includes('run'))
    expect(dockerRun).toBeDefined()
    const args = dockerRun?.[1] as string[]
    expect(args).toContain('chown')
    expect(args).toContain('-R')
    expect(args.join(' ')).toContain(`${WORKTREE}:/w`)
    // …then the worktree metadata is pruned (no second `remove`).
    expect(mockExec.mock.calls.some((c) => c[0] === 'git' && (c[1] as string[])?.includes('prune'))).toBe(true)
  })

  it('rethrows a non-permission error without invoking Docker', () => {
    mockExec.mockImplementation(((file: string, args?: readonly string[]) => {
      if (file === 'git' && args?.includes('remove')) throw new Error('fatal: not a git repository')
      return ''
    }) as unknown as typeof execFileSync)
    expect(() => removeWorktree(PROJECT, WORKTREE)).toThrow(/not a git repository/)
    expect(mockExec.mock.calls.filter((c) => c[0] === 'docker')).toHaveLength(0)
  })

  it('rethrows the original error when Docker is unavailable', () => {
    mockExec.mockImplementation(((file: string, args?: readonly string[]) => {
      if (file === 'docker' && args?.includes('version')) throw new Error('docker: command not found')
      if (file === 'git' && args?.includes('remove')) throw new Error('Permission denied')
      return ''
    }) as unknown as typeof execFileSync)
    expect(() => removeWorktree(PROJECT, WORKTREE)).toThrow(/Permission denied/)
    expect(mockExec.mock.calls.filter((c) => c[0] === 'docker' && (c[1] as string[])?.includes('run'))).toHaveLength(0)
  })

  it('rethrows when the recovery (prune) still fails', () => {
    mockExec.mockImplementation(((file: string, args?: readonly string[]) => {
      if (file === 'docker') return ''
      if (file === 'git' && args?.includes('remove')) throw new Error('Permission denied')
      if (file === 'git' && args?.includes('prune')) throw new Error('prune failed')
      return ''
    }) as unknown as typeof execFileSync)
    expect(() => removeWorktree(PROJECT, WORKTREE)).toThrow(/prune failed/)
  })
})
