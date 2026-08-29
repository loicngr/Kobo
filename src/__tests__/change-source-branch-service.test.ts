// src/__tests__/change-source-branch-service.test.ts
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getWorkspaceMock = vi.fn()
const updateSourceMock = vi.fn()
vi.mock('../server/services/workspace-service.js', () => ({
  getWorkspace: (id: string) => getWorkspaceMock(id),
  updateWorkspaceSourceBranch: (id: string, b: string) => updateSourceMock(id, b),
}))
const agentStatusMock = vi.fn(() => null)
vi.mock('../server/services/agent/orchestrator.js', () => ({
  getAgentStatus: (id: string) => agentStatusMock(id),
}))
vi.mock('../server/services/forge/resolve.js', () => ({ resolveForge: vi.fn(() => 'none') }))
// Configurable per-test (mirror of the agentStatusMock pattern).
const getPrStatusMock = vi.fn(async (): Promise<{ number: number; url: string; state: string } | null> => null)
vi.mock('../server/services/forge/registry.js', () => ({
  getForgeProvider: () => ({
    id: 'none',
    capabilities: { canChangePrBase: false },
    getPrStatus: () => getPrStatusMock(),
    changePrBase: vi.fn(),
  }),
}))

const getEffectiveSettingsMock = vi.fn(() => ({ changeSourceBranchScript: '' }))
vi.mock('../server/services/settings-service.js', () => ({
  getEffectiveSettings: (p: string) => getEffectiveSettingsMock(p),
}))

const spawnMock = vi.fn()
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) }
})

/** Build a fake ChildProcess-like emitter that resolves to `exitCode` after one tick. */
function fakeChildProcess(exitCode: number, stderr = '', pid = 4242): EventEmitter {
  const cp = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    pid: number
    kill: () => void
  }
  cp.stdout = new EventEmitter()
  cp.stderr = new EventEmitter()
  cp.pid = pid
  cp.kill = () => {}
  setImmediate(() => {
    if (stderr) cp.stderr.emit('data', Buffer.from(stderr))
    cp.emit('exit', exitCode, null)
    cp.emit('close', exitCode, null)
  })
  return cp
}

/** Build a fake ChildProcess-like emitter that never exits on its own — the caller drives `exit`. */
function fakePendingChildProcess(
  pid = 4242,
): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number; kill: () => void } {
  const cp = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    pid: number
    kill: () => void
  }
  cp.stdout = new EventEmitter()
  cp.stderr = new EventEmitter()
  cp.pid = pid
  cp.kill = () => {}
  return cp
}

/** Flush pending microtasks (e.g. the PR-lookup await preceding `spawn()`) under fake timers. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** Mirrors the private `SCRIPT_TIMEOUT_MS` constant in change-source-branch-service.ts. */
const SCRIPT_TIMEOUT_MS = 5 * 60 * 1000

import { execFileSync } from 'node:child_process'
import { changeSourceBranch } from '../server/services/change-source-branch-service.js'

function g(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trimEnd()
}

let bare: string
let repo: string

beforeEach(() => {
  vi.clearAllMocks()
  agentStatusMock.mockReturnValue(null)
  spawnMock.mockReset()
  getPrStatusMock.mockReset()
  getPrStatusMock.mockResolvedValue(null)
  getEffectiveSettingsMock.mockReset()
  getEffectiveSettingsMock.mockReturnValue({ changeSourceBranchScript: '' })
  bare = mkdtempSync(join(tmpdir(), 'kobo-csb-bare-'))
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
  repo = mkdtempSync(join(tmpdir(), 'kobo-csb-'))
  g(repo, ['clone', '-q', bare, '.'])
  g(repo, ['config', 'user.email', 't@t.t'])
  g(repo, ['config', 'user.name', 'T'])
  writeFileSync(join(repo, 'base.txt'), 'base\n')
  g(repo, ['add', '.'])
  g(repo, ['commit', '-q', '-m', 'base'])
  g(repo, ['push', '-q', 'origin', 'main'])
  g(repo, ['checkout', '-q', '-b', 'develop'])
  writeFileSync(join(repo, 'dev.txt'), 'dev\n')
  g(repo, ['add', '.'])
  g(repo, ['commit', '-q', '-m', 'D1'])
  g(repo, ['push', '-q', 'origin', 'develop'])
  g(repo, ['checkout', '-q', 'main'])
})

afterEach(() => {
  rmSync(bare, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

describe('changeSourceBranch', () => {
  it('reconstructs the working branch onto the new base and updates metadata', async () => {
    g(repo, ['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(repo, 'feat.txt'), 'feat\n')
    g(repo, ['add', '.'])
    g(repo, ['commit', '-q', '-m', 'F1'])
    getWorkspaceMock.mockReturnValue({
      id: 'w1',
      sourceBranch: 'main',
      workingBranch: 'feature',
      worktreePath: repo,
      projectPath: repo,
    })
    const res = await changeSourceBranch('w1', 'develop')
    expect(res.status).toBe('done')
    expect(g(repo, ['log', '--format=%s', 'feature'])).toContain('D1')
    expect(updateSourceMock).toHaveBeenCalledWith('w1', 'develop')
  })

  it('throws a clean error and does nothing when the new source branch does not exist on origin', async () => {
    g(repo, ['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(repo, 'feat.txt'), 'feat\n')
    g(repo, ['add', '.'])
    g(repo, ['commit', '-q', '-m', 'F1'])
    const tipBefore = g(repo, ['rev-parse', 'HEAD'])
    getWorkspaceMock.mockReturnValue({
      id: 'w1',
      sourceBranch: 'main',
      workingBranch: 'feature',
      worktreePath: repo,
      projectPath: repo,
    })
    await expect(changeSourceBranch('w1', 'no-such-branch')).rejects.toThrow(/does not exist/i)
    // Nothing was done: metadata untouched, working branch tip unchanged.
    expect(updateSourceMock).not.toHaveBeenCalled()
    expect(g(repo, ['rev-parse', 'HEAD'])).toBe(tipBefore)
  })

  it('fetches every branch so the origin refs are current before reconstructing', async () => {
    g(repo, ['checkout', '-q', '-b', 'feature']) // sits on main, 0 own commits
    // A teammate pushes an unrelated branch to origin that `repo` has never fetched.
    const other = mkdtempSync(join(tmpdir(), 'kobo-csb-other-'))
    g(other, ['clone', '-q', bare, '.'])
    g(other, ['config', 'user.email', 't@t.t'])
    g(other, ['config', 'user.name', 'T'])
    g(other, ['checkout', '-q', '-b', 'teammate-branch', 'origin/main'])
    g(other, ['push', '-q', 'origin', 'teammate-branch'])
    rmSync(other, { recursive: true, force: true })
    // `repo` does not know origin/teammate-branch yet.
    expect(() => g(repo, ['rev-parse', '--verify', 'origin/teammate-branch'])).toThrow()

    getWorkspaceMock.mockReturnValue({
      id: 'w1',
      sourceBranch: 'main',
      workingBranch: 'feature',
      worktreePath: repo,
      projectPath: repo,
    })
    await changeSourceBranch('w1', 'develop')

    // The change pulled every branch down, including the unrelated one.
    expect(g(repo, ['rev-parse', '--verify', 'origin/teammate-branch'])).toBeTruthy()
  })

  it('returns "aligned" and skips cherry-pick when the branch has no proper commits', async () => {
    g(repo, ['checkout', '-q', '-b', 'feature'])
    getWorkspaceMock.mockReturnValue({
      id: 'w1',
      sourceBranch: 'main',
      workingBranch: 'feature',
      worktreePath: repo,
      projectPath: repo,
    })
    const res = await changeSourceBranch('w1', 'develop')
    expect(res.status).toBe('aligned')
    expect(g(repo, ['log', '--format=%s', 'feature'])).toContain('D1')
    expect(updateSourceMock).toHaveBeenCalledWith('w1', 'develop')
  })

  it('refuses when the agent is running', async () => {
    agentStatusMock.mockReturnValue('running')
    getWorkspaceMock.mockReturnValue({
      id: 'w1',
      sourceBranch: 'main',
      workingBranch: 'feature',
      worktreePath: repo,
      projectPath: repo,
    })
    await expect(changeSourceBranch('w1', 'develop')).rejects.toThrow(/agent/i)
  })

  it('refuses a dirty worktree on the reconstruct path', async () => {
    g(repo, ['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(repo, 'feat.txt'), 'feat\n')
    g(repo, ['add', '.'])
    g(repo, ['commit', '-q', '-m', 'F1'])
    writeFileSync(join(repo, 'dirty.txt'), 'uncommitted\n')
    getWorkspaceMock.mockReturnValue({
      id: 'w1',
      sourceBranch: 'main',
      workingBranch: 'feature',
      worktreePath: repo,
      projectPath: repo,
    })
    const res = await changeSourceBranch('w1', 'develop')
    expect(res.status).toBe('dirty')
    expect(updateSourceMock).not.toHaveBeenCalled()
  })

  it('refuses the built-in path when dirty-state detection fails (fail-closed), and touches nothing on disk', async () => {
    g(repo, ['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(repo, 'feat.txt'), 'feat\n')
    g(repo, ['add', '.'])
    g(repo, ['commit', '-q', '-m', 'F1'])
    const headBefore = g(repo, ['rev-parse', 'HEAD'])
    // Mirrors `branchExists(repo, 'feature', 'origin')`: true as soon as the
    // local branch exists, which it does — it's the branch we just checked
    // out. Computed before corrupting the index below.
    const forcePushNeededBefore = (() => {
      try {
        g(repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/feature'])
        return true
      } catch {
        return false
      }
    })()

    // Corrupt the index so `git status --porcelain` fails ("index file
    // smaller than expected") while the read-only commands the built-in path
    // already ran (rev-parse, log, branch) keep working — this reproduces,
    // on the reconstruct path, the same `git()` failure mode task 2
    // introduced (timeout, buffer cap, index.lock) that motivated the
    // custom-script fix above.
    writeFileSync(join(repo, '.git', 'index'), 'corrupt')

    getEffectiveSettingsMock.mockReturnValue({ changeSourceBranchScript: '' })
    getWorkspaceMock.mockReturnValue({
      id: 'w1',
      sourceBranch: 'main',
      workingBranch: 'feature',
      worktreePath: repo,
      projectPath: repo,
    })

    const res = await changeSourceBranch('w1', 'develop')

    expect(res.status).toBe('dirty')
    expect(res.commitCount).toBe(1)
    // `forcePushNeeded` (from `branchExists`) is computed before the dirty
    // check and unaffected by this fix; asserting it here just proves this
    // return path carries the real computed values, unlike the custom-script
    // path's hardcoded `{ forcePushNeeded: false, commitCount: 0 }`.
    expect(res.forcePushNeeded).toBe(forcePushNeededBefore)
    expect(updateSourceMock).not.toHaveBeenCalled()
    // No `reset --hard`, no stash attempt: HEAD is exactly where it was.
    const headAfter = g(repo, ['rev-parse', 'HEAD'])
    expect(headAfter).toBe(headBefore)
  })

  it('autostashes uncommitted work on the aligned path and restores it', async () => {
    g(repo, ['checkout', '-q', '-b', 'feature']) // sits on main, 0 own commits
    writeFileSync(join(repo, 'wip.txt'), 'work in progress\n') // dirty (untracked)
    getWorkspaceMock.mockReturnValue({
      id: 'w1',
      sourceBranch: 'main',
      workingBranch: 'feature',
      worktreePath: repo,
      projectPath: repo,
    })
    const res = await changeSourceBranch('w1', 'develop')
    expect(res.status).toBe('aligned')
    // the branch was retargeted onto develop
    expect(g(repo, ['log', '--format=%s', 'feature'])).toContain('D1')
    // the uncommitted file survived the stash round-trip
    expect(existsSync(join(repo, 'wip.txt'))).toBe(true)
    expect(readFileSync(join(repo, 'wip.txt'), 'utf-8')).toBe('work in progress\n')
    expect(updateSourceMock).toHaveBeenCalledWith('w1', 'develop')
  })

  it('reports a structured conflict instead of throwing when the post-reset stash pop conflicts', async () => {
    g(repo, ['checkout', '-q', '-b', 'feature']) // sits on main, 0 own commits (aligned)
    // develop (the new base) modifies base.txt's tracked line and commits it.
    g(repo, ['checkout', '-q', 'develop'])
    writeFileSync(join(repo, 'base.txt'), 'develop version\n')
    g(repo, ['commit', '-q', '-am', 'change base.txt on develop'])
    g(repo, ['push', '-q', 'origin', 'develop'])
    // Back on feature (aligned with the OLD base), dirty the same tracked
    // line without committing so the stash pop conflicts after the hard
    // reset lands develop's content.
    g(repo, ['checkout', '-q', 'feature'])
    writeFileSync(join(repo, 'base.txt'), 'local uncommitted edit\n')
    getWorkspaceMock.mockReturnValue({
      id: 'w1',
      sourceBranch: 'main',
      workingBranch: 'feature',
      worktreePath: repo,
      projectPath: repo,
    })

    const res = await changeSourceBranch('w1', 'develop')

    expect(res.status).toBe('conflict')
    // The DB must still be updated to the new base even though the stash
    // pop needs manual resolution — the worktree is already on `develop`.
    expect(updateSourceMock).toHaveBeenCalledWith('w1', 'develop')
    // The stash must still exist (not silently dropped) so the user can
    // resolve it manually.
    const stashList = g(repo, ['stash', 'list'])
    expect(stashList.trim().length).toBeGreaterThan(0)
  })

  it('returns "conflict" and still records the new base when the cherry-pick conflicts', async () => {
    // develop diverges on base.txt …
    g(repo, ['checkout', '-q', 'develop'])
    writeFileSync(join(repo, 'base.txt'), 'develop-change\n')
    g(repo, ['commit', '-q', '-am', 'D2'])
    g(repo, ['push', '-q', 'origin', 'develop'])
    g(repo, ['checkout', '-q', 'main'])
    // … and feature changes base.txt differently → cherry-pick conflicts.
    g(repo, ['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(repo, 'base.txt'), 'feature-change\n')
    g(repo, ['commit', '-q', '-am', 'F1'])
    getWorkspaceMock.mockReturnValue({
      id: 'w1',
      sourceBranch: 'main',
      workingBranch: 'feature',
      worktreePath: repo,
      projectPath: repo,
    })
    const res = await changeSourceBranch('w1', 'develop')
    expect(res.status).toBe('conflict')
    expect(updateSourceMock).toHaveBeenCalledWith('w1', 'develop')
  })

  it('runs the custom script when changeSourceBranchScript is set and updates metadata on exit 0', async () => {
    g(repo, ['checkout', '-q', '-b', 'feature'])
    getEffectiveSettingsMock.mockReturnValue({ changeSourceBranchScript: 'echo running' })
    spawnMock.mockReturnValue(fakeChildProcess(0))
    getWorkspaceMock.mockReturnValue({
      id: 'w1',
      name: 'Refactor auth',
      sourceBranch: 'main',
      workingBranch: 'feature',
      worktreePath: repo,
      projectPath: repo,
    })

    const res = await changeSourceBranch('w1', 'develop')

    expect(res.status).toBe('done')
    expect(res.forcePushNeeded).toBe(false)
    expect(res.commitCount).toBe(0)
    expect(updateSourceMock).toHaveBeenCalledWith('w1', 'develop')
    // The script was invoked with bash -c <script> + cwd + KOBO_* env.
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [cmd, args, opts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { cwd: string; env: Record<string, string> },
    ]
    expect(cmd).toBe('bash')
    expect(args).toEqual(['-c', 'echo running'])
    expect(opts.cwd).toBe(repo)
    expect(opts.env.KOBO_NEW_BASE).toBe('develop')
    expect(opts.env.KOBO_OLD_BASE).toBe('main')
    expect(opts.env.KOBO_WORKING_BRANCH).toBe('feature')
    expect(opts.env.KOBO_WORKTREE_PATH).toBe(repo)
    expect(opts.env.KOBO_PROJECT_PATH).toBe(repo)
    expect(opts.env.KOBO_PROJECT_NAME).toBe(repo.split('/').pop())
    expect(opts.env.KOBO_WORKSPACE_ID).toBe('w1')
    expect(opts.env.KOBO_WORKSPACE_NAME).toBe('Refactor auth')
    expect(opts.env.KOBO_FORGE).toBe('none')
    // No PR open by default → empty value, never undefined.
    expect(opts.env.KOBO_PR_NUMBER).toBe('')
  })

  it('spawns the custom script detached so a background child does not outlive the timeout kill', async () => {
    g(repo, ['checkout', '-q', '-b', 'feature'])
    getEffectiveSettingsMock.mockReturnValue({ changeSourceBranchScript: 'echo running' })
    spawnMock.mockReturnValue(fakeChildProcess(0))
    getWorkspaceMock.mockReturnValue({
      id: 'w1',
      name: 'Refactor auth',
      sourceBranch: 'main',
      workingBranch: 'feature',
      worktreePath: repo,
      projectPath: repo,
    })

    await changeSourceBranch('w1', 'develop')

    expect(spawnMock).toHaveBeenCalledWith('bash', ['-c', 'echo running'], expect.objectContaining({ detached: true }))
  })

  it('kills the process group with SIGTERM when the script has not exited by SCRIPT_TIMEOUT_MS', async () => {
    vi.useFakeTimers()
    try {
      g(repo, ['checkout', '-q', '-b', 'feature'])
      getEffectiveSettingsMock.mockReturnValue({ changeSourceBranchScript: 'sleep 999' })
      const child = fakePendingChildProcess(4242)
      spawnMock.mockReturnValue(child)
      getWorkspaceMock.mockReturnValue({
        id: 'w1',
        sourceBranch: 'main',
        workingBranch: 'feature',
        worktreePath: repo,
        projectPath: repo,
      })
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)

      const pending = changeSourceBranch('w1', 'develop')
      pending.catch(() => {}) // settled below once the child "exits"

      // Flush the PR-lookup microtask hop that precedes spawn().
      await flushMicrotasks()
      expect(spawnMock).toHaveBeenCalledTimes(1)
      expect(killSpy).not.toHaveBeenCalled()

      // Advance past the watchdog window without the child ever exiting.
      await vi.advanceTimersByTimeAsync(SCRIPT_TIMEOUT_MS)

      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM')

      // Let the child exit so the pending promise settles and nothing leaks.
      child.emit('exit', 0, null)
      await pending
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the group-kill timer (no process.kill) when the script exits before SCRIPT_TIMEOUT_MS', async () => {
    vi.useFakeTimers()
    try {
      g(repo, ['checkout', '-q', '-b', 'feature'])
      getEffectiveSettingsMock.mockReturnValue({ changeSourceBranchScript: 'echo running' })
      const child = fakePendingChildProcess(4242)
      spawnMock.mockReturnValue(child)
      getWorkspaceMock.mockReturnValue({
        id: 'w1',
        sourceBranch: 'main',
        workingBranch: 'feature',
        worktreePath: repo,
        projectPath: repo,
      })
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)

      const pending = changeSourceBranch('w1', 'develop')

      // Flush the PR-lookup microtask hop that precedes spawn(), then exit
      // normally well before the watchdog would ever fire.
      await flushMicrotasks()
      expect(spawnMock).toHaveBeenCalledTimes(1)
      child.emit('exit', 0, null)
      await pending

      // Advance past the full timeout window — clearTimeout should have
      // cancelled the watchdog, so process.kill must never fire.
      await vi.advanceTimersByTimeAsync(SCRIPT_TIMEOUT_MS)

      expect(killSpy).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('exposes KOBO_PR_NUMBER when the forge reports an open PR for the working branch', async () => {
    g(repo, ['checkout', '-q', '-b', 'feature'])
    getEffectiveSettingsMock.mockReturnValue({ changeSourceBranchScript: 'echo running' })
    spawnMock.mockReturnValue(fakeChildProcess(0))
    getPrStatusMock.mockResolvedValueOnce({ number: 42, url: 'https://example.com/pr/42', state: 'OPEN' })
    getWorkspaceMock.mockReturnValue({
      id: 'w1',
      name: 'Refactor auth',
      sourceBranch: 'main',
      workingBranch: 'feature',
      worktreePath: repo,
      projectPath: repo,
    })

    await changeSourceBranch('w1', 'develop')

    const [, , opts] = spawnMock.mock.calls[0] as [string, string[], { env: Record<string, string> }]
    expect(opts.env.KOBO_PR_NUMBER).toBe('42')
  })

  it('keeps KOBO_PR_NUMBER empty when the PR lookup throws (offline / missing CLI)', async () => {
    g(repo, ['checkout', '-q', '-b', 'feature'])
    getEffectiveSettingsMock.mockReturnValue({ changeSourceBranchScript: 'echo running' })
    spawnMock.mockReturnValue(fakeChildProcess(0))
    getPrStatusMock.mockRejectedValueOnce(new Error('gh: command not found'))
    getWorkspaceMock.mockReturnValue({
      id: 'w1',
      name: 'Refactor auth',
      sourceBranch: 'main',
      workingBranch: 'feature',
      worktreePath: repo,
      projectPath: repo,
    })

    await changeSourceBranch('w1', 'develop')

    const [, , opts] = spawnMock.mock.calls[0] as [string, string[], { env: Record<string, string> }]
    expect(opts.env.KOBO_PR_NUMBER).toBe('')
  })

  it('throws the script stderr on a non-zero exit and does not update metadata', async () => {
    g(repo, ['checkout', '-q', '-b', 'feature'])
    getEffectiveSettingsMock.mockReturnValue({ changeSourceBranchScript: 'exit 1' })
    spawnMock.mockReturnValue(fakeChildProcess(1, 'something failed\n'))
    getWorkspaceMock.mockReturnValue({
      id: 'w1',
      sourceBranch: 'main',
      workingBranch: 'feature',
      worktreePath: repo,
      projectPath: repo,
    })
    await expect(changeSourceBranch('w1', 'develop')).rejects.toThrow(/something failed/)
    expect(updateSourceMock).not.toHaveBeenCalled()
  })

  it('refuses the custom-script path when the agent is running', async () => {
    getEffectiveSettingsMock.mockReturnValue({ changeSourceBranchScript: 'echo run' })
    agentStatusMock.mockReturnValue('running')
    getWorkspaceMock.mockReturnValue({
      id: 'w1',
      sourceBranch: 'main',
      workingBranch: 'feature',
      worktreePath: repo,
      projectPath: repo,
    })
    await expect(changeSourceBranch('w1', 'develop')).rejects.toThrow(/agent/i)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('refuses to run the custom script when the worktree is dirty, and destroys nothing', async () => {
    g(repo, ['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(repo, 'feat.txt'), 'feat\n')
    g(repo, ['add', '.'])
    g(repo, ['commit', '-q', '-m', 'F1'])

    // Travail non commité que le `reset --hard` du script par défaut détruirait.
    writeFileSync(join(repo, 'feat.txt'), 'MODIFIE NON COMMITE\n')
    writeFileSync(join(repo, 'untracked.txt'), 'FICHIER NON SUIVI\n')

    // Un script non vide : c'est la configuration PAR DEFAUT du produit.
    getEffectiveSettingsMock.mockReturnValue({ changeSourceBranchScript: 'echo noop' })
    getWorkspaceMock.mockReturnValue({
      id: 'w1',
      sourceBranch: 'main',
      workingBranch: 'feature',
      worktreePath: repo,
      projectPath: repo,
    })

    const res = await changeSourceBranch('w1', 'develop')

    expect(res.status).toBe('dirty')
    // Le script ne doit jamais avoir été lancé.
    expect(spawnMock).not.toHaveBeenCalled()
    // Et rien ne doit avoir bougé sur le disque.
    expect(readFileSync(join(repo, 'feat.txt'), 'utf-8')).toBe('MODIFIE NON COMMITE\n')
    expect(existsSync(join(repo, 'untracked.txt'))).toBe(true)
  })

  it('refuses to run the custom script when dirty-state detection fails (fail-closed), and never spawns it', async () => {
    // `git status` fails outright here (not a git repository at all), which is
    // the most realistic way to trigger `worktreeHasChangesStrict` throwing —
    // the same failure mode task 2 introduced for `git()` (timeout, buffer
    // cap, index.lock).
    const notARepo = mkdtempSync(join(tmpdir(), 'kobo-csb-not-a-repo-'))
    getEffectiveSettingsMock.mockReturnValue({ changeSourceBranchScript: 'echo noop' })
    getWorkspaceMock.mockReturnValue({
      id: 'w1',
      sourceBranch: 'main',
      workingBranch: 'feature',
      worktreePath: notARepo,
      projectPath: repo,
    })

    const res = await changeSourceBranch('w1', 'develop')

    expect(res.status).toBe('dirty')
    expect(spawnMock).not.toHaveBeenCalled()

    rmSync(notARepo, { recursive: true, force: true })
  })

  it('leaves the built-in cherry-pick path untouched when the script is empty', async () => {
    g(repo, ['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(repo, 'feat.txt'), 'feat\n')
    g(repo, ['add', '.'])
    g(repo, ['commit', '-q', '-m', 'F1'])
    // Default mock returns '' — built-in path runs.
    getEffectiveSettingsMock.mockReturnValue({ changeSourceBranchScript: '' })
    getWorkspaceMock.mockReturnValue({
      id: 'w1',
      sourceBranch: 'main',
      workingBranch: 'feature',
      worktreePath: repo,
      projectPath: repo,
    })
    const res = await changeSourceBranch('w1', 'develop')
    expect(res.status).toBe('done')
    expect(spawnMock).not.toHaveBeenCalled()
    expect(g(repo, ['log', '--format=%s', 'feature'])).toContain('D1')
  })
})
