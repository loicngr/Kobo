import {
  authenticateBrowser,
  authenticatedWebSocketUrl,
  consumeBootstrapToken,
  isSameOriginApi,
} from 'src/utils/auth-token'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState({}, '', '/')
})
afterEach(() => vi.restoreAllMocks())

describe('browser authentication', () => {
  it('consumes legacy storage once without retaining an administrative token', () => {
    localStorage.setItem('kobo:network-token', 'legacy')
    expect(consumeBootstrapToken()).toBe('legacy')
    expect(localStorage.getItem('kobo:network-token')).toBeNull()
    expect(consumeBootstrapToken()).toBeNull()
  })
  it('strips bootstrap credentials from the address before authentication', () => {
    window.history.replaceState({}, '', '/?token=legacy&x=1#token=fragment')
    expect(consumeBootstrapToken()).toBe('fragment')
    expect(window.location.search).toBe('?x=1')
    expect(window.location.hash).toBe('')
    expect(consumeBootstrapToken()).toBeNull()
  })
  it('recognizes only same-origin API requests', () => {
    expect(isSameOriginApi('/api/workspaces')).toBe(true)
    expect(isSameOriginApi(`${window.location.origin}/api/settings`)).toBe(true)
    expect(isSameOriginApi('https://example.com/api/x')).toBe(false)
    expect(isSameOriginApi('/assets/logo.png')).toBe(false)
  })
  it('exchanges credentials only with the session endpoint', async () => {
    const fetch = vi.spyOn(window, 'fetch').mockResolvedValue(new Response('{}'))
    const changed = vi.fn()
    window.addEventListener('kobo:auth-token-changed', changed, { once: true })
    await authenticateBrowser('synthetic')
    expect(changed).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith(
      '/api/auth/session',
      expect.objectContaining({
        method: 'POST',
        headers: { 'X-Kobo-Token': 'synthetic' },
        redirect: 'error',
        credentials: 'same-origin',
        signal: expect.any(AbortSignal),
      }),
    )
    expect(localStorage.length).toBe(0)
  })
  it('requests a path-bound ticket and never puts the admin token into WebSocket URLs', async () => {
    const fetch = vi.spyOn(window, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ticket: 't'.repeat(43) })))
    const url = await authenticatedWebSocketUrl('/ws/terminal/workspace-1')
    expect(url).toContain('/ws/terminal/workspace-1?ticket=')
    expect(url).not.toContain('token=')
    expect(fetch).toHaveBeenCalledWith(
      '/api/auth/ws-ticket',
      expect.objectContaining({ body: JSON.stringify({ path: '/ws/terminal/workspace-1' }) }),
    )
    await expect(authenticatedWebSocketUrl('/ws/terminal/../other')).rejects.toThrow()
  })
  it('does not open a socket after rejected authentication', async () => {
    vi.spyOn(window, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }))
    await expect(authenticatedWebSocketUrl('/ws')).rejects.toThrow('401')
  })
})
