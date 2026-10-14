import { authenticateBrowser, authenticatedWebSocketUrl } from 'src/utils/auth-token'
import { closeNetworkLogin, networkLoginOpen } from 'src/utils/network-login-bus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import boot from '../boot/network-auth'

const originalFetch = window.fetch
beforeEach(() => {
  window.history.replaceState({}, '', '/')
  closeNetworkLogin()
})
afterEach(() => {
  window.fetch = originalFetch
  closeNetworkLogin()
})

describe('network authentication response races', () => {
  it.each(['GET', 'POST'])('does not reopen login for an old %s response or replay the request', async (method) => {
    let finishOldRequest!: (response: Response) => void
    const oldResponse = new Promise<Response>((resolve) => {
      finishOldRequest = resolve
    })
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === '/api/auth/session' ? new Response('{}') : oldResponse,
    )
    window.fetch = fetch
    await (boot as () => Promise<void>)()
    const pending = window.fetch('/api/workspaces', { method })
    expect((await authenticateBrowser('new-synthetic-token')).status).toBe(200)
    closeNetworkLogin()
    finishOldRequest(new Response('{}', { status: 401 }))
    expect((await pending).status).toBe(401)
    expect(networkLoginOpen.value).toBe(false)
    expect(fetch.mock.calls.filter(([url]) => url === '/api/workspaces')).toHaveLength(1)
  })

  it('still opens login for a current unauthorized API response', async () => {
    window.fetch = vi.fn(async () => new Response('{}', { status: 401 }))
    await (boot as () => Promise<void>)()
    expect((await window.fetch('/api/workspaces')).status).toBe(401)
    expect(networkLoginOpen.value).toBe(true)
  })

  it('does not reopen login from a stale ticket response after reauthentication', async () => {
    let finishTicket!: (response: Response) => void
    const ticketResponse = new Promise<Response>((resolve) => {
      finishTicket = resolve
    })
    window.fetch = vi.fn(async (input) => (String(input) === '/api/auth/session' ? new Response('{}') : ticketResponse))
    await (boot as () => Promise<void>)()
    const pending = authenticatedWebSocketUrl('/ws')
    expect((await authenticateBrowser('new-synthetic-token')).status).toBe(200)
    closeNetworkLogin()
    finishTicket(new Response('{}', { status: 401 }))
    await expect(pending).rejects.toThrow('401')
    expect(networkLoginOpen.value).toBe(false)
  })

  it('does not treat an unrelated site error as operator authentication failure', async () => {
    window.fetch = vi.fn(async () => new Response('{}', { status: 401 }))
    await (boot as () => Promise<void>)()
    await window.fetch('https://other.example/api/workspaces')
    expect(networkLoginOpen.value).toBe(false)
  })
})
