import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ exec: vi.fn(), workspace: vi.fn(), snapshots: vi.fn(), refresh: vi.fn() }))
vi.mock('node:child_process', () => ({
  spawn: (_command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
    void mocks
      .exec(args)
      .then((stdout: string) => {
        for (let offset = 0; offset < stdout.length; offset += 65536)
          child.stdout.write(stdout.slice(offset, offset + 65536))
        child.emit('close', 0, null)
      })
      .catch((error: { stderr?: string }) => {
        child.stderr.write(error.stderr ?? '')
        child.emit('close', 1, null)
      })
    return child
  },
  execFile: (...args: unknown[]) => {
    const cb = args.at(-1) as (error: unknown, result: { stdout: string }) => void
    mocks
      .exec(args[1])
      .then((stdout: string) => cb(null, { stdout }))
      .catch((error: unknown) => cb(error, { stdout: '' }))
  },
}))
vi.mock('../server/services/workspace-service.js', () => ({ getWorkspace: mocks.workspace }))
vi.mock('../server/services/pr-watcher-service.js', () => ({
  getAllPrSnapshots: mocks.snapshots,
  refreshPrSnapshot: mocks.refresh,
}))

import app from '../server/routes/ci-job-logs.js'
import { githubJobTarget } from '../shared/ci-job-logs.js'

const url = 'https://github.com/org/repo/actions/runs/123/job/456'
const job = {
  run_id: 123,
  status: 'in_progress',
  conclusion: null,
  steps: [{ number: 1, name: 'Tests', status: 'in_progress', conclusion: null }],
}
const request = (target = url, step = '') => app.request(`/ws/ci-job-logs?url=${encodeURIComponent(target)}${step}`)
beforeEach(() => {
  vi.resetAllMocks()
  mocks.workspace.mockReturnValue({ id: 'ws', projectPath: '/repo' })
  mocks.snapshots.mockReturnValue({
    ws: { number: 1, url: 'https://github.com/org/repo/pull/1', ci: { checks: [{ detailsUrl: url }] } },
  })
  mocks.exec.mockResolvedValueOnce(JSON.stringify(job)).mockResolvedValue('hello')
})
describe('CI job logs', () => {
  it('reads only a linked job and its validated step', async () => {
    const response = await request(url, '&step=1')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ logs: 'hello', available: true, status: 'in_progress' })
    expect(mocks.exec.mock.calls[1]?.[0]).toContain('repos/org/repo/actions/jobs/456/steps/1/logs')
  })
  it.each([
    'https://evil.test/org/repo/actions/runs/123/job/456',
    'https://github.com/../repo/actions/runs/123/job/456',
  ])('rejects invalid URL %s', async (target) => {
    expect(githubJobTarget(target)).toBeNull()
    expect((await request(target)).status).toBe(400)
    expect(mocks.exec).not.toHaveBeenCalled()
  })
  it('rejects another job before invoking authenticated CLI', async () => {
    expect((await request(url.replace('456', '789'))).status).toBe(404)
    expect(mocks.exec).not.toHaveBeenCalled()
  })
  it('rejects a mismatched run and nonexistent step', async () => {
    expect((await request(url, '&step=2')).status).toBe(404)
    mocks.exec.mockReset().mockResolvedValue(JSON.stringify({ ...job, run_id: 999 }))
    expect((await request()).status).toBe(404)
  })
  it('handles unpublished logs without exposing CLI details', async () => {
    mocks.exec.mockReset().mockResolvedValueOnce(JSON.stringify(job)).mockRejectedValue({ stderr: 'HTTP 404 secret' })
    expect(await (await request()).json()).toMatchObject({ available: false, logs: '' })
  })
  it('sanitizes failures', async () => {
    mocks.exec.mockReset().mockRejectedValue(new Error('secret'))
    const response = await request()
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('secret')
  })
  it('bounds large responses', async () => {
    mocks.exec.mockReset().mockResolvedValueOnce(JSON.stringify(job)).mockResolvedValue('x'.repeat(300_000))
    const body = await (await request()).json()
    expect(body.truncated).toBe(true)
    expect(body.logs.length).toBe(256 * 1024)
  })
})

it('keeps the actual end of logs larger than the old CLI buffer', async () => {
  mocks.exec
    .mockReset()
    .mockResolvedValueOnce(JSON.stringify(job))
    .mockResolvedValue(`${'x'.repeat(9 * 1024 * 1024)}FINAL_FAILURE`)
  const body = await (await request()).json()
  expect(body.logs.endsWith('FINAL_FAILURE')).toBe(true)
  expect(body.logs.length).toBe(256 * 1024)
  expect(body.truncated).toBe(true)
  expect(body.available).toBe(true)
})
it('does not expose partial stdout when the download fails', async () => {
  mocks.exec.mockReset().mockResolvedValueOnce(JSON.stringify(job)).mockRejectedValue({ stderr: 'secret HTTP 503' })
  const response = await request()
  expect(response.status).toBe(502)
  expect(await response.text()).not.toContain('secret')
})

it('preserves ANSI colors while stripping terminal commands', async () => {
  mocks.exec
    .mockReset()
    .mockResolvedValueOnce(JSON.stringify(job))
    .mockResolvedValue('\u001b[31mFailure\u001b[0m\u001b[2J\u001b]8;;https://evil.test\u0007\u001b]8;;\u0007')
  const response = await request()
  expect(await response.json()).toMatchObject({ logs: '\u001b[31mFailure\u001b[0m', available: true })
  expect(mocks.exec.mock.calls[1]?.[0]).toContain('--allow-escape-sequences')
})

it('falls back only when an older gh rejects the ANSI flag', async () => {
  mocks.exec
    .mockReset()
    .mockResolvedValueOnce(JSON.stringify(job))
    .mockRejectedValueOnce({ stderr: 'unknown flag: --allow-escape-sequences' })
    .mockResolvedValueOnce('old CLI logs')
  expect(await (await request()).json()).toMatchObject({ logs: 'old CLI logs', available: true })
  expect(mocks.exec).toHaveBeenCalledTimes(3)
  expect(mocks.exec.mock.calls[2]?.[0]).not.toContain('--allow-escape-sequences')
})
