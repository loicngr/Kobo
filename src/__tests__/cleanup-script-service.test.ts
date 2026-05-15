import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock websocket-service (used by the shared script-runner).
vi.mock('../server/services/websocket-service.js', () => ({
  emit: vi.fn(),
  emitEphemeral: vi.fn(),
}))

import { runCleanupScript, shouldRunCleanup } from '../server/services/cleanup-script-service.js'
import * as wsService from '../server/services/websocket-service.js'

describe('shouldRunCleanup()', () => {
  const base = {
    reason: 'completed' as const,
    wasAutoLoop: false,
    autoLoopCompleted: false,
    script: 'echo hi',
    mode: 'idle' as const,
    pendingTasks: 0,
  }

  it('never runs when the script is empty or whitespace', () => {
    expect(shouldRunCleanup({ ...base, script: '' })).toBe(false)
    expect(shouldRunCleanup({ ...base, script: '   ' })).toBe(false)
    expect(shouldRunCleanup({ ...base, autoLoopCompleted: true, script: '' })).toBe(false)
  })

  it('always runs on the auto-loop completion path (script present)', () => {
    expect(shouldRunCleanup({ ...base, autoLoopCompleted: true, mode: 'no-tasks', pendingTasks: 5 })).toBe(true)
  })

  it('does not run when the agent did not finish cleanly', () => {
    expect(shouldRunCleanup({ ...base, reason: 'error' })).toBe(false)
    expect(shouldRunCleanup({ ...base, reason: 'killed' })).toBe(false)
  })

  it('never runs on a mid-loop session end', () => {
    expect(shouldRunCleanup({ ...base, wasAutoLoop: true })).toBe(false)
    expect(shouldRunCleanup({ ...base, wasAutoLoop: true, mode: 'no-tasks', pendingTasks: 0 })).toBe(false)
  })

  it("mode 'idle' runs after a session even if tasks remain", () => {
    expect(shouldRunCleanup({ ...base, mode: 'idle', pendingTasks: 3 })).toBe(true)
    expect(shouldRunCleanup({ ...base, mode: 'idle', pendingTasks: 0 })).toBe(true)
  })

  it("mode 'no-tasks' runs only when no task remains", () => {
    expect(shouldRunCleanup({ ...base, mode: 'no-tasks', pendingTasks: 1 })).toBe(false)
    expect(shouldRunCleanup({ ...base, mode: 'no-tasks', pendingTasks: 0 })).toBe(true)
  })
})

describe('runCleanupScript()', () => {
  let tmpDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-cleanup-test-'))
    fs.mkdirSync(path.join(tmpDir, '.ai'), { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns exitCode 0 for a successful script', async () => {
    const result = await runCleanupScript('ws-1', tmpDir, '#!/usr/bin/env bash\necho "cleaned"')
    expect(result.exitCode).toBe(0)
  })

  it('returns a non-zero exitCode for a failing script', async () => {
    const result = await runCleanupScript('ws-1', tmpDir, '#!/usr/bin/env bash\nexit 7')
    expect(result.exitCode).toBe(7)
  })

  it('emits cleanup:output events for stdout', async () => {
    await runCleanupScript('ws-1', tmpDir, '#!/usr/bin/env bash\necho "line"')
    const outputCalls = vi.mocked(wsService.emit).mock.calls.filter(([, type]) => type === 'cleanup:output')
    expect(outputCalls.length).toBeGreaterThan(0)
  })

  it('emits cleanup:complete with hadOutput:false when the script printed nothing', async () => {
    await runCleanupScript('ws-1', tmpDir, '#!/usr/bin/env bash\nexit 0')
    expect(vi.mocked(wsService.emitEphemeral)).toHaveBeenCalledWith('ws-1', 'cleanup:complete', { hadOutput: false })
  })

  it('emits cleanup:complete with hadOutput:true when the script printed something', async () => {
    await runCleanupScript('ws-1', tmpDir, '#!/usr/bin/env bash\necho "cleaned"')
    expect(vi.mocked(wsService.emitEphemeral)).toHaveBeenCalledWith('ws-1', 'cleanup:complete', { hadOutput: true })
  })
})
