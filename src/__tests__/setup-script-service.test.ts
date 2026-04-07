import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock websocket-service
vi.mock('../server/services/websocket-service.js', () => ({
  emit: vi.fn(),
  emitEphemeral: vi.fn(),
}))

import { runSetupScript } from '../server/services/setup-script-service.js'
import * as wsService from '../server/services/websocket-service.js'

describe('setup-script-service', () => {
  let tmpDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-setup-test-'))
    fs.mkdirSync(path.join(tmpDir, '.ai'), { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns exitCode 0 for a successful script', async () => {
    const result = await runSetupScript('ws-1', tmpDir, '#!/usr/bin/env bash\necho "hello"')
    expect(result.exitCode).toBe(0)
  })

  it('returns non-zero exitCode for a failing script', async () => {
    const result = await runSetupScript('ws-1', tmpDir, '#!/usr/bin/env bash\nexit 42')
    expect(result.exitCode).toBe(42)
  })

  it('emits setup:output events for stdout', async () => {
    await runSetupScript('ws-1', tmpDir, '#!/usr/bin/env bash\necho "line1"\necho "line2"')
    const outputCalls = vi.mocked(wsService.emit).mock.calls.filter(([, type]) => type === 'setup:output')
    const texts = outputCalls.map(([, , payload]) => (payload as { text: string }).text)
    expect(texts.some((t) => t.includes('line1'))).toBe(true)
    expect(texts.some((t) => t.includes('line2'))).toBe(true)
  })

  it('emits setup:output events for stderr', async () => {
    await runSetupScript('ws-1', tmpDir, '#!/usr/bin/env bash\necho "err" >&2')
    const outputCalls = vi.mocked(wsService.emit).mock.calls.filter(([, type]) => type === 'setup:output')
    const texts = outputCalls.map(([, , payload]) => (payload as { text: string }).text)
    expect(texts.some((t) => t.includes('err'))).toBe(true)
  })

  it('emits setup:complete on success', async () => {
    await runSetupScript('ws-1', tmpDir, '#!/usr/bin/env bash\necho "ok"')
    expect(vi.mocked(wsService.emitEphemeral)).toHaveBeenCalledWith('ws-1', 'setup:complete', {})
  })

  it('emits setup:error on failure', async () => {
    await runSetupScript('ws-1', tmpDir, '#!/usr/bin/env bash\nexit 1')
    expect(vi.mocked(wsService.emitEphemeral)).toHaveBeenCalledWith(
      'ws-1',
      'setup:error',
      expect.objectContaining({ exitCode: 1 }),
    )
  })

  it('cleans up temporary script file after execution', async () => {
    await runSetupScript('ws-1', tmpDir, '#!/usr/bin/env bash\necho "ok"')
    const tmpFile = path.join(tmpDir, '.ai', '.setup-script.tmp')
    expect(fs.existsSync(tmpFile)).toBe(false)
  })

  it('preserves shebang in the temp script', async () => {
    const result = await runSetupScript('ws-1', tmpDir, '#!/bin/sh\necho "sh works"')
    expect(result.exitCode).toBe(0)
  })

  it('kills the process and returns non-zero on timeout', async () => {
    const result = await runSetupScript('ws-1', tmpDir, '#!/usr/bin/env bash\nsleep 30', undefined, 1000)
    expect(result.exitCode).not.toBe(0)
    const outputCalls = vi.mocked(wsService.emit).mock.calls.filter(([, type]) => type === 'setup:output')
    const texts = outputCalls.map(([, , payload]) => (payload as { text: string }).text)
    expect(texts.some((t) => t.includes('timed out'))).toBe(true)
  }, 10000)

  it('passes environment variables to the script', async () => {
    const script = '#!/usr/bin/env bash\necho "WID=$WORKSPACE_ID"'
    await runSetupScript('ws-1', tmpDir, script, {
      workspaceName: 'test-ws',
      branchName: 'feature/test',
      sourceBranch: 'main',
      projectPath: '/tmp/project',
    })
    const outputCalls = vi.mocked(wsService.emit).mock.calls.filter(([, type]) => type === 'setup:output')
    const texts = outputCalls.map(([, , payload]) => (payload as { text: string }).text)
    expect(texts.some((t) => t.includes('WID=ws-1'))).toBe(true)
  })
})
