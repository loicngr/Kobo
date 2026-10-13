import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('../server/utils/script-runner.js', () => ({ runScript: vi.fn(async () => ({ exitCode: 0 })) }))
vi.mock('../server/db/index.js', () => ({ getDb: vi.fn() }))
vi.mock('../server/services/settings-service.js', () => ({
  getEffectiveSettings: vi.fn(() => ({ shutdownScript: 'echo stopping' })),
  getGlobalSettings: vi.fn(() => ({ worktreesPrefixByProject: false })),
  getProjectSettings: vi.fn(() => null),
}))
vi.mock('../server/services/workspace-service.js', () => ({ listWorkspaces: vi.fn() }))

import { getDb } from '../server/db/index.js'
import { onKoboShutdown, SHUTDOWN_SCRIPT_TIMEOUT_MS } from '../server/services/lifecycle-hook-service.js'
import { listWorkspaces } from '../server/services/workspace-service.js'
import { runScript } from '../server/utils/script-runner.js'
import { makeWorkspace } from './helpers/fixtures.js'

let directory: string
beforeEach(() => {
  vi.clearAllMocks()
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-shutdown-hooks-'))
  vi.mocked(getDb).mockReturnValue({
    prepare: () => ({
      get: (id: string) => ({
        id,
        name: id,
        project_path: directory,
        working_branch: 'feature/test',
        source_branch: 'main',
        worktree_path: path.join(directory, id),
      }),
    }),
  } as never)
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(directory, { recursive: true, force: true })
})

it('runs once in each existing worktree including archived workspaces, skipping purged and missing paths', async () => {
  for (const id of ['active', 'archived', 'purged']) fs.mkdirSync(path.join(directory, id))
  vi.mocked(listWorkspaces).mockReturnValue([
    makeWorkspace({ id: 'active' }),
    makeWorkspace({ id: 'archived', archivedAt: '2026-10-13' }),
    makeWorkspace({ id: 'purged', worktreePurgedAt: '2026-10-13' }),
    makeWorkspace({ id: 'missing' }),
  ])
  await onKoboShutdown('SIGTERM', () => false)
  expect(listWorkspaces).toHaveBeenCalledWith(true)
  expect(runScript).toHaveBeenCalledTimes(2)
  expect(vi.mocked(runScript).mock.calls.map(([options]) => options.worktreePath)).toEqual([
    path.join(directory, 'active'),
    path.join(directory, 'archived'),
  ])
  for (const [options] of vi.mocked(runScript).mock.calls) {
    expect(options).toMatchObject({
      timeoutMs: SHUTDOWN_SCRIPT_TIMEOUT_MS,
      extraEnv: { KOBO_HOOK_EVENT: 'kobo-shutdown', KOBO_SHUTDOWN_SIGNAL: 'SIGTERM' },
    })
  }
})

it('does not run a shutdown script alongside an agent whose stop is unconfirmed', async () => {
  fs.mkdirSync(path.join(directory, 'busy'))
  vi.mocked(listWorkspaces).mockReturnValue([makeWorkspace({ id: 'busy' })])
  await onKoboShutdown('SIGINT', () => true)
  expect(runScript).not.toHaveBeenCalled()
})

it('reports script failures without preventing other workspace hooks or shutdown', async () => {
  for (const id of ['failed', 'ok']) fs.mkdirSync(path.join(directory, id))
  vi.mocked(listWorkspaces).mockReturnValue(['failed', 'ok'].map((id) => makeWorkspace({ id })))
  vi.mocked(runScript).mockResolvedValueOnce({ exitCode: 1 }).mockResolvedValueOnce({ exitCode: 0 })
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  await expect(onKoboShutdown('SIGHUP', () => false)).resolves.toBeUndefined()
  expect(runScript).toHaveBeenCalledTimes(2)
  expect(error).toHaveBeenCalledWith(expect.stringContaining("'failed' with code 1"))
})
