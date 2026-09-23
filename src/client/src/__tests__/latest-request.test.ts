import { describe, expect, it } from 'vitest'

describe('createLatestRequest', () => {
  it('aborts the previous request when a new one begins', async () => {
    const { createLatestRequest } = await import('../utils/latest-request')
    const guard = createLatestRequest()

    const first = guard.begin()
    expect(first.aborted).toBe(false)

    const second = guard.begin()
    // Three quick clicks in the diff tree used to leave three requests in
    // flight; whichever landed last won, regardless of what was asked for.
    expect(first.aborted).toBe(true)
    expect(second.aborted).toBe(false)
  })

  it('only recognises the newest signal as current', async () => {
    const { createLatestRequest } = await import('../utils/latest-request')
    const guard = createLatestRequest()
    const first = guard.begin()
    const second = guard.begin()
    expect(guard.isCurrent(first)).toBe(false)
    expect(guard.isCurrent(second)).toBe(true)
  })

  it('stops recognising any signal once aborted', async () => {
    const { createLatestRequest } = await import('../utils/latest-request')
    const guard = createLatestRequest()
    const signal = guard.begin()
    guard.abort()
    expect(signal.aborted).toBe(true)
    expect(guard.isCurrent(signal)).toBe(false)
  })

  it('is a no-op when aborting before any request', async () => {
    const { createLatestRequest } = await import('../utils/latest-request')
    const guard = createLatestRequest()
    expect(() => guard.abort()).not.toThrow()
  })
})

describe('isAbortError', () => {
  it('recognises the DOMException produced by aborting a fetch', async () => {
    const { isAbortError } = await import('../utils/latest-request')
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true)
  })

  it('does not swallow a real failure', async () => {
    const { isAbortError } = await import('../utils/latest-request')
    expect(isAbortError(new Error('HTTP 500'))).toBe(false)
    expect(isAbortError(null)).toBe(false)
    expect(isAbortError('boom')).toBe(false)
  })
})
