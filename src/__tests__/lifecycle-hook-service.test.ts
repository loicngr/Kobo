import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/services/websocket-service.js', () => ({
  emit: vi.fn(),
  emitEphemeral: vi.fn(),
}))

vi.mock('../server/db/index.js', () => ({
  getDb: vi.fn(() => ({
    prepare: () => ({ get: () => workspaceRow }),
  })),
}))

vi.mock('../server/services/settings-service.js', () => ({
  getEffectiveSettings: vi.fn(() => effectiveSettings),
  getGlobalSettings: vi.fn(() => ({ worktreesPath: '', worktreesPrefixByProject: false })),
  getProjectSettings: vi.fn(() => null),
}))

import {
  onAutoLoopDisabled,
  onPrMerged,
  onSessionEnded,
  runLifecycleHook,
} from '../server/services/lifecycle-hook-service.js'
import { getEffectiveSettings } from '../server/services/settings-service.js'
import * as wsService from '../server/services/websocket-service.js'

let tmpDir: string
let workspaceRow: Record<string, unknown> | undefined
let effectiveSettings: Record<string, string>

/** The script writes its environment to a file so the test can read it back. */
const DUMP_ENV = '#!/usr/bin/env bash\nenv > "$WORKTREE_DUMP"\n'

function readDump(): Record<string, string> {
  const raw = fs.readFileSync(path.join(tmpDir, 'env.txt'), 'utf-8')
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return out
}

beforeEach(() => {
  vi.clearAllMocks()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-hook-test-'))
  process.env.WORKTREE_DUMP = path.join(tmpDir, 'env.txt')
  workspaceRow = {
    id: 'ws-1',
    name: 'demo',
    project_path: '/tmp/project',
    working_branch: 'feature/x',
    source_branch: 'develop',
    worktree_path: tmpDir,
  }
  effectiveSettings = {
    sessionEndedScript: '',
    prMergedScript: '',
    autoLoopDisabledScript: '',
  }
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.WORKTREE_DUMP
})

describe('runLifecycleHook', () => {
  it('does nothing when the hook is not configured', async () => {
    const result = await runLifecycleHook('session-ended', 'ws-1', {})

    expect(result).toBeNull()
    expect(wsService.emit).not.toHaveBeenCalled()
  })

  it('treats a whitespace-only script as disabled, not as something to run', async () => {
    effectiveSettings.sessionEndedScript = '   \n  '

    expect(await runLifecycleHook('session-ended', 'ws-1', {})).toBeNull()
  })

  it('runs the configured script and reports its exit code', async () => {
    effectiveSettings.prMergedScript = '#!/usr/bin/env bash\nexit 7'

    const result = await runLifecycleHook('pr-merged', 'ws-1', {})

    expect(result).toEqual({ exitCode: 7 })
  })

  it('skips silently when the worktree is gone rather than spawning in a missing directory', async () => {
    effectiveSettings.sessionEndedScript = 'echo hi'
    workspaceRow = { ...workspaceRow, worktree_path: path.join(tmpDir, 'nope') }

    expect(await runLifecycleHook('session-ended', 'ws-1', {})).toBeNull()
  })

  it('returns null for an unknown workspace instead of throwing', async () => {
    workspaceRow = undefined

    expect(await runLifecycleHook('session-ended', 'ws-missing', {})).toBeNull()
  })

  it('exposes the workspace identity and the event payload to the script', async () => {
    effectiveSettings.sessionEndedScript = DUMP_ENV

    await runLifecycleHook('session-ended', 'ws-1', { KOBO_SESSION_END_REASON: 'watchdog' })

    const env = readDump()
    expect(env.WORKSPACE_ID).toBe('ws-1')
    expect(env.WORKSPACE_NAME).toBe('demo')
    expect(env.BRANCH_NAME).toBe('feature/x')
    expect(env.SOURCE_BRANCH).toBe('develop')
    expect(env.PROJECT_PATH).toBe('/tmp/project')
    expect(env.KOBO_SESSION_END_REASON).toBe('watchdog')
    expect(env.KOBO_HOOK_EVENT).toBe('session-ended')
  })

  it('streams output under a per-event namespace so one hook cannot be mistaken for another', async () => {
    effectiveSettings.autoLoopDisabledScript = '#!/usr/bin/env bash\necho "from the hook"'

    await runLifecycleHook('autoloop-disabled', 'ws-1', {})

    const types = vi.mocked(wsService.emit).mock.calls.map(([, type]) => type)
    expect(types).toContain('hook:autoloop-disabled:output')
  })
})

describe('lifecycle hook entry points', () => {
  it('passes the session outcome through to the script', async () => {
    effectiveSettings.sessionEndedScript = DUMP_ENV

    await onSessionEnded('ws-1', { sessionId: 'sess-9', reason: 'error', exitCode: 1 })

    const env = readDump()
    expect(env.KOBO_SESSION_ID).toBe('sess-9')
    expect(env.KOBO_SESSION_END_REASON).toBe('error')
    expect(env.KOBO_SESSION_EXIT_CODE).toBe('1')
  })

  it('writes an empty exit code rather than the string "null" when the engine reports none', async () => {
    effectiveSettings.sessionEndedScript = DUMP_ENV

    await onSessionEnded('ws-1', { sessionId: 'sess-9', reason: 'completed', exitCode: null })

    expect(readDump().KOBO_SESSION_EXIT_CODE).toBe('')
  })

  it('passes the PR number and URL through to the script', async () => {
    effectiveSettings.prMergedScript = DUMP_ENV

    await onPrMerged('ws-1', { prNumber: 42, prUrl: 'https://example.test/pr/42' })

    const env = readDump()
    expect(env.KOBO_PR_NUMBER).toBe('42')
    expect(env.KOBO_PR_URL).toBe('https://example.test/pr/42')
  })

  it('passes the auto-loop disable reason through to the script', async () => {
    effectiveSettings.autoLoopDisabledScript = DUMP_ENV

    await onAutoLoopDisabled('ws-1', { reason: 'stall', tasksPending: 3 })

    const env = readDump()
    expect(env.KOBO_AUTOLOOP_REASON).toBe('stall')
    expect(env.KOBO_TASKS_PENDING).toBe('3')
  })

  it('never rejects when resolving the hook itself throws — a hook must not break the lifecycle', async () => {
    // A failing SCRIPT already resolves (runScript never rejects); the case
    // that needs the guard is Kōbō's own code throwing before the spawn.
    vi.mocked(getEffectiveSettings).mockImplementationOnce(() => {
      throw new Error('settings.json is unreadable')
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(onSessionEnded('ws-1', { sessionId: 's', reason: 'completed', exitCode: 0 })).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("'session-ended' hook failed"), expect.any(Error))
    errorSpy.mockRestore()
  })

  it('tells the script who stopped the session and whether auto-loop was driving it', async () => {
    effectiveSettings.sessionEndedScript = DUMP_ENV

    await onSessionEnded('ws-1', {
      sessionId: 's',
      reason: 'killed',
      exitCode: null,
      stopCause: 'user',
      autoLoopActive: true,
    })

    const env = readDump()
    expect(env.KOBO_SESSION_STOP_CAUSE).toBe('user')
    // A hook that runs the test suite needs to know the next iteration is
    // already editing the same files.
    expect(env.KOBO_AUTOLOOP_ACTIVE).toBe('1')
  })

  it('leaves the stop cause empty when the session ended on its own', async () => {
    effectiveSettings.sessionEndedScript = DUMP_ENV

    await onSessionEnded('ws-1', { sessionId: 's', reason: 'completed', exitCode: 0, autoLoopActive: false })

    const env = readDump()
    expect(env.KOBO_SESSION_STOP_CAUSE).toBe('')
    expect(env.KOBO_AUTOLOOP_ACTIVE).toBe('0')
  })

  it('warns when a session-ended hook finds no worktree — that one is not expected', async () => {
    effectiveSettings.sessionEndedScript = 'echo hi'
    workspaceRow = { ...workspaceRow, worktree_path: path.join(tmpDir, 'gone') }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await runLifecycleHook('session-ended', 'ws-1', {})

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('worktree missing'))
    warnSpy.mockRestore()
  })

  it('stays silent when a pr-merged hook finds no worktree — auto-purge makes that routine', async () => {
    effectiveSettings.prMergedScript = 'echo hi'
    workspaceRow = { ...workspaceRow, worktree_path: path.join(tmpDir, 'gone') }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await runLifecycleHook('pr-merged', 'ws-1', {})

    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
