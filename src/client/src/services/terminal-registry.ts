import type { FitAddon } from '@xterm/addon-fit'
import type { Terminal } from '@xterm/xterm'
import { ref } from 'vue'

export interface TerminalEntry {
  terminal: Terminal
  fitAddon: FitAddon
  ws: WebSocket | null
  exited: boolean
  exitCode: number | null
  error: string | null
  container: HTMLDivElement // persistent DOM container for this terminal
  opened: boolean // whether terminal.open() has been called
  onDataDisposable?: { dispose: () => void }
  /** Connection lost while the shell is still alive — distinct from `exited`. */
  disconnected: boolean
  /** 1-based count of consecutive reconnection attempts. 0 when connected. */
  reconnectAttempt: number
  reconnectTimer?: ReturnType<typeof setTimeout>
}

/** Singleton — survives component remount AND workspace switches. */
export const terminalMap = new Map<string, TerminalEntry>()

/** Bumped on every map mutation so computed()s can depend on the map. */
export const terminalStateVersion = ref(0)
export function bumpTerminalState(): void {
  terminalStateVersion.value++
}

// Shared cleanup gesture — reused at every site that must not leave a stale
// reconnect timer armed: closing the terminal, reopening it, the manual
// "Reconnect" button, and refocusing a workspace tab. Repeating the inline
// `if (entry.reconnectTimer) clearTimeout(...)` at four call sites is exactly
// how one of them gets missed; centralizing it here means there's only one
// place to get right.
export function clearReconnectTimer(entry: TerminalEntry): void {
  if (entry.reconnectTimer) {
    clearTimeout(entry.reconnectTimer)
    entry.reconnectTimer = undefined
  }
}

/**
 * Fully dispose one workspace's terminal: timer, socket, xterm instance, map
 * entry. Safe to call for a workspace with no terminal. Used by the panel's
 * close button AND by workspace archive/purge/delete so a removed workspace
 * never leaks a live PTY connection.
 */
export function disposeTerminalEntry(workspaceId: string): void {
  const entry = terminalMap.get(workspaceId)
  if (!entry) return

  // Clear any pending reconnect timer AND stop this close from scheduling a
  // new one — the classic leak this kind of fix introduces if skipped:
  // ws.close() fires `onclose` asynchronously, and by then the entry is gone
  // from terminalMap but scheduleReconnect doesn't consult the map, so it
  // would happily reconnect a terminal the user just closed.
  clearReconnectTimer(entry)
  if (entry.ws) {
    entry.ws.onclose = null
    if (entry.ws.readyState === WebSocket.OPEN) entry.ws.close()
  }
  entry.onDataDisposable?.dispose()
  entry.terminal.dispose()
  terminalMap.delete(workspaceId)
  bumpTerminalState()
}
