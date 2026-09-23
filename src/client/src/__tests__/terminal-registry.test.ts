import { describe, expect, it, vi } from 'vitest'
import type { TerminalEntry } from '../services/terminal-registry'
import { disposeTerminalEntry, terminalMap } from '../services/terminal-registry'

function fakeEntry(): TerminalEntry {
  return {
    terminal: { dispose: vi.fn() } as unknown as TerminalEntry['terminal'],
    fitAddon: {} as TerminalEntry['fitAddon'],
    ws: { onclose: () => {}, readyState: WebSocket.OPEN, close: vi.fn() } as unknown as WebSocket,
    exited: false,
    exitCode: null,
    error: null,
    container: document.createElement('div'),
    opened: true,
    onDataDisposable: { dispose: vi.fn() },
    disconnected: false,
    reconnectAttempt: 0,
    reconnectTimer: setTimeout(() => {}, 60_000),
  }
}

describe('terminal-registry', () => {
  it('disposes socket, xterm, and map entry', () => {
    const entry = fakeEntry()
    terminalMap.set('w1', entry)
    disposeTerminalEntry('w1')
    expect(terminalMap.has('w1')).toBe(false)
    expect(entry.terminal.dispose).toHaveBeenCalled()
    expect((entry.ws as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled()
    expect((entry.onDataDisposable as { dispose: ReturnType<typeof vi.fn> }).dispose).toHaveBeenCalled()
  })

  it('is a no-op for an unknown workspace', () => {
    expect(() => disposeTerminalEntry('nope')).not.toThrow()
  })

  it('does not close an already-closed socket', () => {
    const entry = fakeEntry()
    ;(entry.ws as unknown as { readyState: number }).readyState = WebSocket.CLOSED
    terminalMap.set('w2', entry)
    disposeTerminalEntry('w2')
    expect((entry.ws as unknown as { close: ReturnType<typeof vi.fn> }).close).not.toHaveBeenCalled()
  })
})
