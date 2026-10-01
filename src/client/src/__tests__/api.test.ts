import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  ApiTimeoutError,
  apiFetch,
  apiFetchOk,
  apiFetchResponse,
  apiFetchResponseForStatus,
  apiFetchStatus,
  apiResponseError,
  apiTimeoutForPath,
} from '../utils/api'

function jsonResponse(status: number, body: unknown, ok = status < 400) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('apiFetch', () => {
  it('keeps explicit token headers supplied as a Headers object with JSON bodies', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    await apiFetch('/api/settings', {
      method: 'POST',
      headers: new Headers({ 'X-Kobo-Token': 'candidate' }),
      body: { enabled: true },
    })
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('X-Kobo-Token')).toBe('candidate')
  })

  it('settles at the deadline even when a pending transport ignores cancellation', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    )
    const result = apiFetch('/api/workspaces', { timeoutMs: 50 }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(50)
    expect(await Promise.race([result, Promise.resolve('still pending')])).toBeInstanceOf(ApiTimeoutError)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the server error message instead of an HTTP code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(422, { error: 'Failed to extract Notion page: token missing' })),
    )

    await expect(apiFetch('/api/workspaces')).rejects.toMatchObject({
      name: 'ApiError',
      status: 422,
      message: 'Failed to extract Notion page: token missing',
    })
  })

  it('carries the server discriminator code when present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(409, { error: 'dirty', code: 'dirty_worktree' })))

    const err = await apiFetch('/api/workspaces/w1/rebase', { method: 'POST' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('dirty_worktree')
  })

  it('falls back to the HTTP code only when the body carries no message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, text: async () => '' } as Response))

    await expect(apiFetch('/api/settings')).rejects.toThrow('HTTP 502')
  })

  it('serialises a plain object body as JSON with the right header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await apiFetch('/api/settings/global', { method: 'PUT', body: { editorCommand: 'code' } })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.body).toBe('{"editorCommand":"code"}')
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
  })

  it('aborts and reports a timeout when the server never answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
          }),
      ),
    )

    await expect(apiFetch('/api/workspaces', { timeoutMs: 5 })).rejects.toBeInstanceOf(ApiTimeoutError)
  })

  it('wraps a non-JSON body on a successful response in ApiError instead of throwing a raw SyntaxError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'not json at all' } as Response),
    )

    const err = await apiFetch('/api/settings').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).message).toContain('non-JSON body')
    expect((err as ApiError).status).toBe(200)
  })

  it('truncates an oversized non-JSON error body instead of leaking it whole', async () => {
    const oversized = 'x'.repeat(1000)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 502, text: async () => oversized } as Response),
    )

    const err = await apiFetch('/api/settings').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).message.length).toBe(500)
    expect((err as ApiError).body).toBe(oversized)
  })

  it('lets the caller abort without disguising it as a timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
          }),
      ),
    )

    const controller = new AbortController()
    const promise = apiFetch('/api/workspaces', { signal: controller.signal, timeoutMs: 10_000 })
    controller.abort()

    await expect(promise).rejects.toSatisfy((err: unknown) => !(err instanceof ApiTimeoutError))
  })
})

describe('Response transport', () => {
  it('releases the deadline and caller listener when only the status is needed', async () => {
    vi.useFakeTimers()
    const caller = new AbortController()
    const removeListener = vi.spyOn(caller.signal, 'removeEventListener')
    const body = new Response('ignored')
    const cancel = vi.spyOn(body.body!, 'cancel')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(body))

    expect(await apiFetchStatus('/api/test', { signal: caller.signal, timeoutMs: 60_000 })).toEqual({
      ok: true,
      status: 200,
    })
    expect(vi.getTimerCount()).toBe(0)
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('consumes an acknowledgement body and preserves server errors', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"ok":true}')))
    await apiFetchOk('/api/workspaces/w1/stop', { method: 'POST', timeoutMs: 60_000 })
    expect(vi.getTimerCount()).toBe(0)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"stop denied"}', { status: 409 })))
    await expect(apiFetchOk('/api/workspaces/w1/stop', { method: 'POST' })).rejects.toMatchObject({
      status: 409,
      message: 'stop denied',
    })
  })

  it('releases successful status responses but keeps error bodies readable', async () => {
    vi.useFakeTimers()
    const success = new Response('ignored')
    const cancel = vi.spyOn(success.body!, 'cancel')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(success))
    const status = await apiFetchResponseForStatus('/api/test', { timeoutMs: 60_000 })
    expect(status.ok).toBe(true)
    expect(cancel).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"blocked"}', { status: 403 })))
    const error = await apiFetchResponseForStatus('/api/test', { timeoutMs: 60_000 })
    expect(error.ok).toBe(false)
    expect(await error.json()).toEqual({ error: 'blocked' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains business-specific HTTP statuses and descriptive errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: 'Worktree is dirty', code: 'dirty_worktree' }), { status: 409 }),
        ),
    )
    const response = await apiFetchResponse('/api/workspaces/w1/rebase')
    expect(response.status).toBe(409)
    expect(await apiResponseError(response)).toMatchObject({
      status: 409,
      code: 'dirty_worktree',
      message: 'Worktree is dirty',
    })
  })

  it('preserves binary download bytes', async () => {
    const bytes = new Uint8Array([0, 1, 255, 17])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes, { headers: { 'Content-Type': 'image/png' } })))
    const response = await apiFetchResponse('/api/image')
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(new Uint8Array(await (await response.blob()).arrayBuffer())).toEqual(bytes)
  })

  it('keeps one total deadline across headers and a stalled body', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => {}) }))
    const response = await apiFetchResponse('/api/test', { timeoutMs: 50 })
    await vi.advanceTimersByTimeAsync(30)
    const result = response.json().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(20)
    expect(await result).toBeInstanceOf(ApiTimeoutError)
    expect(await result).toMatchObject({ executionMayContinue: false })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never retries a timed-out mutation that may have executed', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(() => new Promise(() => {}))
    vi.stubGlobal('fetch', fetchMock)
    const result = apiFetchResponse('/api/workspaces/w1/push', { method: 'POST', timeoutMs: 10 }).catch(
      (error: unknown) => error,
    )
    await vi.advanceTimersByTimeAsync(10)
    expect(await result).toBeInstanceOf(ApiTimeoutError)
    expect(await result).toMatchObject({ executionMayContinue: true })
    expect(((await result) as ApiTimeoutError).message).toContain('Refresh its status')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('allows server-bounded slow operations enough time to finish', () => {
    expect(apiTimeoutForPath('/api/workspaces/w1/sessions')).toBe(30_000)
    expect(apiTimeoutForPath('/api/workspaces/w1/fetch?force=true', 'POST')).toBe(180_000)
    expect(apiTimeoutForPath('/api/dev-server/w1/start', 'POST')).toBe(180_000)
    expect(apiTimeoutForPath('/api/voice/workspaces/w1/transcribe', 'POST')).toBe(330_000)
    expect(apiTimeoutForPath('/api/workspaces', 'POST')).toBe(330_000)
    expect(apiTimeoutForPath('/api/workspaces/w1/archive', 'POST')).toBe(180_000)
    expect(apiTimeoutForPath('/api/workspaces/w1', 'DELETE')).toBe(180_000)
    expect(apiTimeoutForPath('/api/workspaces/w1/start-review', 'POST')).toBe(180_000)
    expect(apiTimeoutForPath('/api/workspaces/w1/switch-engine', 'POST')).toBe(180_000)
    expect(apiTimeoutForPath('/api/dev-server/w1/stop', 'POST')).toBe(180_000)
  })
})

it('does not issue a request with an already aborted signal', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  const controller = new AbortController()
  controller.abort()
  await expect(apiFetch('/api/test', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  expect(fetchMock).not.toHaveBeenCalled()
})

it('keeps the deadline active while consuming the response body', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => ({
      ok: true,
      status: 200,
      text: () =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        }),
    })),
  )
  await expect(apiFetch('/api/test', { timeoutMs: 10 })).rejects.toBeInstanceOf(ApiTimeoutError)
})
