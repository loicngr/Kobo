import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { port, tick, status } = vi.hoisted(() => ({
  port: { on: vi.fn(), postMessage: vi.fn(), close: vi.fn() },
  tick: vi.fn(),
  status: vi.fn(() => ({ state: 'ready', processed: 1, total: 1 })),
}))
vi.mock('node:worker_threads', () => ({ parentPort: port, workerData: { dbPath: ':memory:' } }))
vi.mock('better-sqlite3', () => ({
  default: class {
    pragma() {}
    close() {}
  },
}))
vi.mock('../server/services/search/indexer.js', () => ({
  SearchIndexer: class {
    tick = tick
    status = status
  },
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  tick.mockReset()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

it.each(['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT'])(
  'retries %s without making search permanently unavailable',
  async (code) => {
    tick.mockImplementationOnce(() => {
      throw Object.assign(new Error('database is locked'), { code })
    })
    await import('../server/services/search/worker.js')
    await vi.advanceTimersByTimeAsync(1000)
    expect(tick.mock.calls.length).toBeGreaterThan(1)
    expect(port.postMessage).toHaveBeenCalledWith({ status: { state: 'ready', processed: 1, total: 1 } })
    expect(port.postMessage.mock.calls.some(([message]) => message.status?.state === 'error')).toBe(false)
  },
)

it('still reports non-transient database failures and stops pumping', async () => {
  tick.mockImplementationOnce(() => {
    throw Object.assign(new Error('disk failure'), { code: 'SQLITE_IOERR' })
  })
  await import('../server/services/search/worker.js')
  await vi.advanceTimersByTimeAsync(1000)
  expect(tick).toHaveBeenCalledTimes(1)
  expect(port.postMessage).toHaveBeenCalledWith({
    status: expect.objectContaining({ state: 'error', error: expect.stringContaining('disk failure') }),
  })
})
