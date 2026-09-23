import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  shouldConnectOnFocus,
  TERMINAL_RECONNECT_MAX_ATTEMPTS,
  terminalReconnectDelayMs,
} from '../utils/terminal-reconnect'

describe('terminalReconnectDelayMs', () => {
  it('reconnects almost immediately on the first attempt', () => {
    expect(terminalReconnectDelayMs(1)).toBe(500)
  })

  it('backs off so a dead backend is not hammered', () => {
    const delays = [1, 2, 3, 4].map(terminalReconnectDelayMs)
    expect(delays).toEqual([500, 1000, 2000, 4000])
  })

  it('caps the delay so a returning backend is picked up quickly', () => {
    expect(terminalReconnectDelayMs(TERMINAL_RECONNECT_MAX_ATTEMPTS)).toBeLessThanOrEqual(10_000)
  })

  it('gives up past the last attempt so the user is not left waiting forever', () => {
    expect(terminalReconnectDelayMs(TERMINAL_RECONNECT_MAX_ATTEMPTS + 1)).toBeNull()
  })
})

describe('TerminalPanel close handling', () => {
  const source = readFileSync(join(process.cwd(), 'src/components/TerminalPanel.vue'), 'utf-8')

  it('does more on close than blanking the socket reference', () => {
    expect(source).toMatch(/ws\.onclose\s*=\s*\(\)\s*=>\s*\{[\s\S]{0,600}scheduleReconnect/)
  })

  it('exposes a disconnected state distinct from exited', () => {
    expect(source).toMatch(/disconnected/)
    expect(source).toMatch(/terminal\.disconnected/)
  })

  it('cancels a pending reconnect timer before deciding to connect on workspace focus', () => {
    // Regression: switching away from a workspace while a reconnect backoff
    // is armed, then switching back, used to fire an immediate connectWs
    // from this watcher on top of the still-pending timer — two sockets
    // racing to replace the same entry.
    const watchBlock = source.match(/watch\(workspaceId,[\s\S]*?\n\}\)/)?.[0]
    expect(watchBlock).toBeDefined()
    expect(watchBlock).toMatch(/clearReconnectTimer/)
    expect(watchBlock).toMatch(/shouldConnectOnFocus/)
  })
})

describe('shouldConnectOnFocus', () => {
  it('reconnects a closed-but-alive terminal on focus', () => {
    expect(shouldConnectOnFocus({ wsOpen: false, exited: false })).toBe(true)
  })

  it('does not reconnect an already-open socket', () => {
    expect(shouldConnectOnFocus({ wsOpen: true, exited: false })).toBe(false)
  })

  it('never reconnects a shell that exited on its own', () => {
    expect(shouldConnectOnFocus({ wsOpen: false, exited: true })).toBe(false)
  })
})
