import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let tmpHome: string
const previousHome = process.env.KOBO_HOME

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-logger-test-'))
  process.env.KOBO_HOME = tmpHome
  const { _resetLoggerForTest } = await import('../server/utils/logger.js')
  _resetLoggerForTest()
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.KOBO_HOME
  else process.env.KOBO_HOME = previousHome
  if (tmpHome && fs.existsSync(tmpHome)) fs.rmSync(tmpHome, { recursive: true, force: true })
})

describe('structured logger', () => {
  it('writes one JSON line per event, under the Kōbō home', async () => {
    const { getLogFilePath, logError } = await import('../server/utils/logger.js')

    logError('purge', 'stopAgent failed', { workspaceId: 'w1' })

    const contents = fs.readFileSync(getLogFilePath(), 'utf-8').trim().split('\n')
    expect(contents).toHaveLength(1)
    const entry = JSON.parse(contents[0]) as { level: string; scope: string; message: string; meta: unknown }
    expect(entry.level).toBe('error')
    expect(entry.scope).toBe('purge')
    expect(entry.message).toBe('stopAgent failed')
    expect(entry.meta).toEqual({ workspaceId: 'w1' })
  })

  it('reads back the most recent entries, newest first', async () => {
    const { logInfo, logWarn, readRecentLogs } = await import('../server/utils/logger.js')

    logInfo('a', 'first')
    logWarn('b', 'second')

    const recent = readRecentLogs({ limit: 10 })
    expect(recent.map((e) => e.message)).toEqual(['second', 'first'])
  })

  it('filters by level so an incident hunt is not drowned in info lines', async () => {
    const { logError, logInfo, readRecentLogs } = await import('../server/utils/logger.js')

    logInfo('a', 'noise')
    logError('b', 'the actual problem')

    const errors = readRecentLogs({ level: 'error' })
    expect(errors.map((e) => e.message)).toEqual(['the actual problem'])
  })

  it('rotates the file instead of growing without bound', async () => {
    const { getLogFilePath, log, _resetLoggerForTest } = await import('../server/utils/logger.js')
    _resetLoggerForTest()

    // Each entry carries a large meta blob so the size cap is reached fast.
    const blob = 'x'.repeat(64 * 1024)
    for (let i = 0; i < 120; i++) log('info', 'bulk', `entry ${i}`, { blob })

    expect(fs.existsSync(`${getLogFilePath()}.1`)).toBe(true)
    expect(fs.statSync(getLogFilePath()).size).toBeLessThan(6 * 1024 * 1024)
  })

  it('never throws when the log directory cannot be written', async (ctx) => {
    // Root ignores `chmod 0444` and writes anyway: the assertion below would
    // pass without ever reaching the failure path it claims to cover — a
    // false green, which is exactly what this suite exists to prevent.
    if (process.getuid?.() === 0) {
      ctx.skip('running as root: chmod 0444 is not a write barrier, the test would be a false green')
    }
    const { log, _resetLoggerForTest } = await import('../server/utils/logger.js')

    // A read-only KOBO_HOME reliably rejects `mkdir logs/` with EACCES, unlike
    // a synthetic path (e.g. under /proc) whose recursive-mkdir behavior is
    // platform-dependent and can hang instead of failing fast.
    fs.chmodSync(tmpHome, 0o444)
    _resetLoggerForTest()

    try {
      // A logging failure must never take down the operation being logged.
      expect(() => log('error', 'x', 'y')).not.toThrow()
    } finally {
      fs.chmodSync(tmpHome, 0o755) // restore so afterEach can remove the directory
    }
  })
})
