import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock websocket-service (used by the shared script-runner).
vi.mock('../server/services/websocket-service.js', () => ({
  emit: vi.fn(),
  emitEphemeral: vi.fn(),
}))

import { runArchiveScript } from '../server/services/archive-script-service.js'
import * as wsService from '../server/services/websocket-service.js'

describe('runArchiveScript()', () => {
  let tmpDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-archive-test-'))
    fs.mkdirSync(path.join(tmpDir, '.ai'), { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns exitCode 0 for a successful script', async () => {
    const result = await runArchiveScript('ws-1', tmpDir, '#!/usr/bin/env bash\necho "archived"')
    expect(result.exitCode).toBe(0)
  })

  it('returns a non-zero exitCode for a failing script', async () => {
    const result = await runArchiveScript('ws-1', tmpDir, '#!/usr/bin/env bash\nexit 9')
    expect(result.exitCode).toBe(9)
  })

  it('emits archive:output events and archive:complete on success', async () => {
    await runArchiveScript('ws-1', tmpDir, '#!/usr/bin/env bash\necho "line"')
    const outputCalls = vi.mocked(wsService.emit).mock.calls.filter(([, type]) => type === 'archive:output')
    expect(outputCalls.length).toBeGreaterThan(0)
    expect(vi.mocked(wsService.emitEphemeral)).toHaveBeenCalledWith('ws-1', 'archive:complete', {
      hadOutput: true,
    })
  })
})
