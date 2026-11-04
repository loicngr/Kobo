// @vitest-environment node
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

function setup(ack: boolean, windows = true, silentFirst = false) {
  let click!: (event: unknown) => void
  const openWindow = vi.fn().mockResolvedValue(undefined)
  const focus = vi.fn().mockResolvedValue(undefined)
  const postMessage = vi.fn((_message, ports) => {
    if (ack) ports[0].reply()
  })
  class Channel {
    port1 = { onmessage: null as null | ((event: unknown) => void), close: vi.fn(), postMessage: vi.fn() }
    port2 = { reply: () => this.port1.onmessage?.({ data: { type: 'kobo-notification-received', id: 'click' } }) }
  }
  runInNewContext(readFileSync('public/notification-worker.js', 'utf8'), {
    self: {
      registration: { scope: 'https://kobo.test/' },
      addEventListener: (_: string, handler: typeof click) => {
        click = handler
      },
    },
    clients: {
      matchAll: async () =>
        windows
          ? [
              ...(silentFirst ? [{ url: 'https://kobo.test/#/', focus, postMessage: vi.fn() }] : []),
              { url: 'https://kobo.test/#/', focus, postMessage },
            ]
          : [],
      openWindow,
    },
    MessageChannel: Channel,
    URL,
    crypto: { randomUUID: () => 'click' },
    setTimeout: (fn: () => void) => setTimeout(fn, 5),
    clearTimeout,
  })
  let work!: Promise<void>
  const fire = (target: unknown) => {
    click({
      notification: { data: { target }, close: vi.fn() },
      waitUntil: (promise: Promise<void>) => {
        work = promise
      },
    })
    return work
  }
  return { fire, openWindow, postMessage }
}

describe('notification worker click', () => {
  it('treats receipt as sufficient even if the page later cancels navigation', async () => {
    const worker = setup(true)
    await worker.fire({ workspaceId: 'w', sessionId: 's' })
    expect(worker.postMessage).toHaveBeenCalledOnce()
    expect(worker.openWindow).not.toHaveBeenCalled()
  })
  it('uses a responsive second window when the first is silent', async () => {
    const worker = setup(true, true, true)
    await worker.fire({ workspaceId: 'w' })
    expect(worker.postMessage).toHaveBeenCalledOnce()
    expect(worker.openWindow).not.toHaveBeenCalled()
  })
  it('opens the session deep link when no window responds', async () => {
    const worker = setup(false)
    await worker.fire({ workspaceId: 'a/b', sessionId: 's?' })
    expect(worker.openWindow).toHaveBeenCalledWith('https://kobo.test/#/workspace/a%2Fb?session=s%3F')
  })
  it('rejects malformed targets and opens a cold window for valid targets', async () => {
    const worker = setup(false, false)
    expect(worker.fire({ workspaceId: 'w', url: 'https://evil.test' })).toBeUndefined()
    await worker.fire({ workspaceId: 'w' })
    expect(worker.openWindow).toHaveBeenCalledWith('https://kobo.test/#/workspace/w')
  })
})
