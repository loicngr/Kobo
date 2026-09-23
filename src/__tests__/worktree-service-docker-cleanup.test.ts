import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runBoundedProcess } from '../server/utils/bounded-process.js'

vi.mock('../server/utils/bounded-process.js', () => ({ runBoundedProcess: vi.fn() }))

import { removeWorktree } from '../server/services/worktree-service.js'

const mockExec = vi.mocked(runBoundedProcess)

// worktree path intentionally NOT under the project dir, so removeFromExclude no-ops (no real fs).
const PROJECT = '/tmp/proj'
const WORKTREE = '/tmp/other/ws'

beforeEach(() => {
  mockExec.mockReset()
})

describe('removeWorktree Docker cleanup', () => {
  it('happy path: git remove succeeds, Docker is never invoked', async () => {
    mockExec.mockResolvedValue('')
    await removeWorktree(PROJECT, WORKTREE)
    expect(mockExec.mock.calls.filter((c) => c[0] === 'docker')).toHaveLength(0)
  })

  it('recovers from a permission error (French locale message) via Docker chown then prune', async () => {
    mockExec.mockImplementation(async (file: string, args?: readonly string[]) => {
      if (file === 'docker') return ''
      // The first `git worktree remove` already de-registered the worktree, so the
      // recovery uses fs.rm + `git worktree prune`, never a second remove.
      // The real-world failure: a French host reports "Permission non accordée".
      if (file === 'git' && args?.includes('remove')) {
        throw new Error("erreur : échec de la suppression de '/tmp/other/ws': Permission non accordée")
      }
      return ''
    })

    await expect(removeWorktree(PROJECT, WORKTREE)).resolves.toBeUndefined()
    // git is invoked under the C locale so its errors are deterministic English.
    // (the very first git call is the repository-lock's `rev-parse --git-common-dir`)
    const gitCall = mockExec.mock.calls.find((c) => c[0] === 'git' && (c[1] as string[])?.includes('remove'))
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

  it('rethrows a non-permission error without invoking Docker', async () => {
    mockExec.mockImplementation(async (file: string, args?: readonly string[]) => {
      if (file === 'git' && args?.includes('remove')) throw new Error('fatal: not a git repository')
      return ''
    })
    await expect(removeWorktree(PROJECT, WORKTREE)).rejects.toThrow(/not a git repository/)
    expect(mockExec.mock.calls.filter((c) => c[0] === 'docker')).toHaveLength(0)
  })

  it('rethrows the original error when Docker is unavailable', async () => {
    mockExec.mockImplementation(async (file: string, args?: readonly string[]) => {
      if (file === 'docker' && args?.includes('version')) throw new Error('docker: command not found')
      if (file === 'git' && args?.includes('remove')) throw new Error('Permission denied')
      return ''
    })
    await expect(removeWorktree(PROJECT, WORKTREE)).rejects.toThrow(/Permission denied/)
    expect(mockExec.mock.calls.filter((c) => c[0] === 'docker' && (c[1] as string[])?.includes('run'))).toHaveLength(0)
  })

  it('rethrows when the recovery (prune) still fails', async () => {
    mockExec.mockImplementation(async (file: string, args?: readonly string[]) => {
      if (file === 'docker') return ''
      if (file === 'git' && args?.includes('remove')) throw new Error('Permission denied')
      if (file === 'git' && args?.includes('prune')) throw new Error('prune failed')
      return ''
    })
    await expect(removeWorktree(PROJECT, WORKTREE)).rejects.toThrow(/prune failed/)
  })
})

it('stops the named cleanup container after a CLI timeout before releasing the operation', async () => {
  let running = false
  let cleanupName = ''
  mockExec.mockImplementation(async (file, args) => {
    if (file === 'git' && args.includes('remove')) throw new Error('Permission denied')
    if (file === 'docker' && args[0] === 'run') {
      cleanupName = args[args.indexOf('--name') + 1] ?? ''
      running = true
      throw new Error('docker timed out')
    }
    if (file === 'docker' && args[0] === 'ps') return running ? 'container-id running\n' : ''
    if (file === 'docker' && args[0] === 'stop') throw new Error('stop failed')
    if (file === 'docker' && args[0] === 'kill') {
      running = false
      return ''
    }
    return ''
  })
  await expect(removeWorktree(PROJECT, WORKTREE)).rejects.toThrow('timed out')
  expect(cleanupName).toMatch(/^kobo-cleanup-/)
  expect(running).toBe(false)
  expect(mockExec).toHaveBeenCalledWith('docker', ['kill', cleanupName], expect.anything())
})

it('retains the repository lock when cleanup-container inspection fails', async () => {
  const { withGitRepoLock } = await import('../server/utils/git-repo-lock.js')
  let inspectionAvailable = false
  mockExec.mockImplementation(async (file, args) => {
    if (file === 'git' && args.includes('remove')) throw new Error('Permission denied')
    if (file === 'docker' && args[0] === 'run') throw new Error('daemon disconnected')
    if (file === 'docker' && args[0] === 'ps' && !inspectionAvailable) throw new Error('daemon unavailable')
    return ''
  })
  const pending = removeWorktree(PROJECT, WORKTREE)
  const result = expect(pending).rejects.toThrow('daemon disconnected')
  await vi.waitFor(() =>
    expect(mockExec.mock.calls.some(([file, args]) => file === 'docker' && args[0] === 'ps')).toBe(true),
  )
  let entered = false
  const next = withGitRepoLock(PROJECT, () => {
    entered = true
  })
  try {
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(entered).toBe(false)
  } finally {
    inspectionAvailable = true
    await result
    await next
  }
  expect(entered).toBe(true)
})
