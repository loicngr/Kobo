import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { _resetTrackedProcessesForTests, startDevServer, stopDevServer } from '../server/services/dev-server-service.js'
import { makeProjectSettings, makeWorkspace } from './helpers/fixtures.js'

vi.mock('../server/services/workspace-service.js', () => ({
  getWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  updateDevServerStatus: vi.fn(),
}))
vi.mock('../server/services/settings-service.js', () => ({ getProjectSettings: vi.fn() }))
vi.mock('../server/services/websocket-service.js', () => ({ emitEphemeral: vi.fn() }))

import { getProjectSettings } from '../server/services/settings-service.js'
import { getWorkspace } from '../server/services/workspace-service.js'

let root: string
let childPid: number | undefined
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-process-group-'))
  vi.mocked(getWorkspace).mockReturnValue(makeWorkspace({ id: 'w', projectPath: root, worktreePath: root }))
  _resetTrackedProcessesForTests()
})
afterEach(async () => {
  if (childPid) {
    try {
      process.kill(childPid, 'SIGKILL')
    } catch {}
  }
  childPid = undefined
  await stopDevServer('w').catch(() => {})
  _resetTrackedProcessesForTests()
  fs.rmSync(root, { recursive: true, force: true })
})

it.each([false, true])(
  'stops descendants when the shell has already exited: %s',
  async (exitBeforeStop) => {
    fs.writeFileSync(
      path.join(root, 'child.cjs'),
      `const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync('child.pid', String(process.pid)); setInterval(() => fs.appendFileSync('writes', '.'), 10)`,
    )
    const escapedNode = `'${process.execPath.replaceAll("'", "'\\''")}'`
    vi.mocked(getProjectSettings).mockReturnValue(
      makeProjectSettings({
        devServer: {
          startCommand: `${escapedNode} child.cjs & ${exitBeforeStop ? 'exit 0' : 'wait'}`,
          stopCommand: '',
        },
      }),
    )
    startDevServer('w')
    await vi.waitFor(() => expect(fs.existsSync(path.join(root, 'writes'))).toBe(true))
    childPid = Number(fs.readFileSync(path.join(root, 'child.pid'), 'utf8'))
    expect((await stopDevServer('w')).status).toBe('stopped')
    const writes = fs.readFileSync(path.join(root, 'writes'), 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(fs.readFileSync(path.join(root, 'writes'), 'utf8')).toBe(writes)
  },
  10_000,
)
