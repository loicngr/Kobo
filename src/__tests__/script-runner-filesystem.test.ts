import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runScript } from '../server/utils/script-runner.js'

vi.mock('../server/services/websocket-service.js', () => ({ emit: vi.fn(), emitEphemeral: vi.fn() }))
let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-script-files-'))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

it.each(['directory', 'leaf'])('never overwrites an external file through a %s symlink', async (kind) => {
  const worktree = path.join(root, 'worktree')
  fs.mkdirSync(worktree)
  const outside = path.join(root, 'outside')
  fs.mkdirSync(outside)
  const target = path.join(outside, '.hook.tmp')
  fs.writeFileSync(target, 'sentinel')
  if (kind === 'directory') fs.symlinkSync(outside, path.join(worktree, '.ai'))
  else {
    fs.mkdirSync(path.join(worktree, '.ai'))
    fs.symlinkSync(target, path.join(worktree, '.ai/.hook.tmp'))
  }
  const result = await runScript({
    workspaceId: 'w',
    worktreePath: worktree,
    script: 'true',
    eventPrefix: 'hook',
    tmpFileName: '.hook.tmp',
  })
  expect(fs.readFileSync(target, 'utf8')).toBe('sentinel')
  expect(result.exitCode).toBe(kind === 'directory' ? 1 : 0)
})

it('reports a missing worktree as a script failure rather than rejecting', async () => {
  await expect(
    runScript({
      workspaceId: 'w',
      worktreePath: path.join(root, 'missing'),
      script: 'true',
      eventPrefix: 'hook',
      tmpFileName: '.hook.tmp',
    }),
  ).resolves.toEqual({ exitCode: 1 })
})

it('gives concurrent scripts with the same requested filename independent files', async () => {
  const results = await Promise.all(
    ['first', 'second'].map((name) =>
      runScript({
        workspaceId: 'w',
        worktreePath: root,
        script: `sleep 0.05\nprintf '%s' '${name}' > '${name}.txt'`,
        eventPrefix: 'hook',
        tmpFileName: '.hook.tmp',
      }),
    ),
  )
  expect(results.map((result) => result.exitCode)).toEqual([0, 0])
  expect(fs.readFileSync(path.join(root, 'first.txt'), 'utf8')).toBe('first')
  expect(fs.readFileSync(path.join(root, 'second.txt'), 'utf8')).toBe('second')
  expect(fs.readdirSync(path.join(root, '.ai'))).toEqual([])
})
