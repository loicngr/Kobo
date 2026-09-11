import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { runBoundedProcess } from '../server/utils/bounded-process.js'
import { isWorkspaceLifecycleBusy, withWorkspaceLifecycleGuard } from '../server/utils/workspace-lifecycle-guard.js'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('drains large output and escalates a real process that ignores TERM', async () => {
  const result = await runBoundedProcess(
    process.execPath,
    ['-e', "process.stdout.write('x'.repeat(2 * 1024 * 1024))"],
    { timeoutMs: 2000 },
  )
  expect(result).toBe('')
  const root = mkdtempSync(join(tmpdir(), 'kobo-stop-'))
  roots.push(root)
  const pidFile = join(root, 'pid')
  await expect(
    runBoundedProcess('bash', ['-c', 'trap "" TERM; echo $$ > "$1"; while :; do sleep 1; done', '--', pidFile], {
      timeoutMs: 200,
      graceMs: 50,
    }),
  ).rejects.toThrow('timed out')
  const pid = Number(readFileSync(pidFile, 'utf8'))
  expect(() => process.kill(pid, 0)).toThrow()
})

it('retains lifecycle ownership until a supposedly killed process actually exits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kobo-stop-unconfirmed-'))
  roots.push(root)
  const pidFile = join(root, 'pid')
  const actualKill = process.kill.bind(process)
  let pid: number | undefined
  vi.spyOn(process, 'kill').mockImplementation((target, signal) =>
    signal === 'SIGKILL' ? true : actualKill(target, signal),
  )
  const pending = withWorkspaceLifecycleGuard('unconfirmed-script', () =>
    runBoundedProcess('bash', ['-c', 'trap "" TERM; echo $$ > "$1"; while :; do sleep 1; done', '--', pidFile], {
      timeoutMs: 100,
      graceMs: 25,
    }),
  )
  let settled = false
  const observed = pending.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  try {
    await vi.waitFor(() => {
      pid = Number(readFileSync(pidFile, 'utf8'))
      expect(pid).toBeGreaterThan(0)
    })
    await delay(250)
    expect(settled).toBe(false)
    expect(isWorkspaceLifecycleBusy('unconfirmed-script')).toBe(true)
  } finally {
    if (pid) actualKill(-pid, 'SIGKILL')
    await observed
  }
  expect(isWorkspaceLifecycleBusy('unconfirmed-script')).toBe(false)
})

it.each([0, 1])('retains a detached child after its shell exits with code %s', async (exitCode) => {
  const started = Date.now()
  await expect(
    runBoundedProcess('bash', ['-c', `sleep 20 >/dev/null 2>&1 & exit ${exitCode}`], { timeoutMs: 150, graceMs: 25 }),
  ).rejects.toThrow('timed out')
  expect(Date.now() - started).toBeGreaterThanOrEqual(100)
})
