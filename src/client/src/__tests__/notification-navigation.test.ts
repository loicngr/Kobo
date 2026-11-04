import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../utils/sprint-navigation', () => ({
  navigateToWorkspaceTarget: vi.fn().mockResolvedValue(false),
  saveWorkspaceTargetForAuthentication: vi.fn(),
}))

import type { Router } from 'vue-router'
import {
  installNotificationNavigation,
  validNotificationTarget,
  workspaceTargetUrl,
} from '../utils/notification-navigation'
import { navigateToWorkspaceTarget } from '../utils/sprint-navigation'

describe('notification target reception', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
  })
  it('validates destinations and encodes session links', () => {
    expect(validNotificationTarget({ workspaceId: 'w', sessionId: 's', url: 'https://evil.test' })).toBe(false)
    expect(validNotificationTarget({ workspaceId: '', sessionId: 's' })).toBe(false)
    expect(workspaceTargetUrl({ workspaceId: 'a/b', sessionId: 's?' })).toContain('#/workspace/a%2Fb?session=s%3F')
  })
  it('acknowledges valid worker messages once per click independently of navigation', async () => {
    let receive!: (event: MessageEvent) => void
    const controller = {}
    vi.stubGlobal('navigator', {
      serviceWorker: {
        controller,
        addEventListener: (_: string, callback: typeof receive) => {
          receive = callback
        },
      },
    })
    const router = { isReady: () => Promise.resolve() } as Router
    installNotificationNavigation(router)
    const port = {
      postMessage: vi.fn(),
      close: vi.fn(),
      onmessage: null as null | ((event: { data: unknown }) => void),
    }
    const message = {
      source: controller,
      ports: [port],
      data: { type: 'kobo-notification-click', id: 'unique', target: { workspaceId: 'w', sessionId: 's' } },
    } as unknown as MessageEvent
    receive(message)
    receive(message)
    expect(navigateToWorkspaceTarget).not.toHaveBeenCalled()
    port.onmessage?.({ data: { type: 'kobo-notification-deliver', id: 'unique' } })
    port.onmessage?.({ data: { type: 'kobo-notification-deliver', id: 'unique' } })
    await Promise.resolve()
    expect(port.postMessage).toHaveBeenCalledTimes(2)
    expect(navigateToWorkspaceTarget).toHaveBeenCalledOnce()
    expect(navigateToWorkspaceTarget).toHaveBeenCalledWith(
      router,
      { workspaceId: 'w', sessionId: 's' },
      {},
      expect.any(Function),
    )
    receive({ ...message, source: {} } as MessageEvent)
    expect(port.postMessage).toHaveBeenCalledTimes(2)
    vi.unstubAllGlobals()
  })
})
