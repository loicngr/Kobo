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

  it('provides the matching Docker identity to the archive script', async () => {
    const project = path.join(tmpDir, 'base-project')
    fs.mkdirSync(path.join(project, '.container/instances'), { recursive: true })
    fs.writeFileSync(
      path.join(project, '.container/instances/workspace.env'),
      'INSTANCE_NAME=feature-x\nPROJECT_NAME=app-feature-x\n',
    )
    const result = await runArchiveScript('ws-1', tmpDir, 'printf "%s/%s" "$PROJECT_NAME" "$INSTANCE" > identity.txt', {
      workspaceName: 'demo',
      branchName: 'feature/x',
      sourceBranch: 'develop',
      projectPath: project,
    })
    expect(result.exitCode).toBe(0)
    expect(fs.readFileSync(path.join(tmpDir, 'identity.txt'), 'utf8')).toBe('app-feature-x/feature-x')
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
