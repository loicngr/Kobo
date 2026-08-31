import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, ApiTimeoutError, apiFetch } from '../utils/api'

function jsonResponse(status: number, body: unknown, ok = status < 400) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('apiFetch', () => {
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
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
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
