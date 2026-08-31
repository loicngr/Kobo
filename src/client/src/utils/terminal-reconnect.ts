/**
 * Reconnection schedule for the workspace terminal.
 *
 * A closed socket used to leave the panel looking OPEN: `isOpen` only checks
 * `!exited`, so after a backend restart or a laptop waking from sleep the user
 * kept typing into a dead connection, every keystroke dropped by the
 * `readyState === OPEN` guard in the onData listener.
 *
 * Doubling from 500 ms picks a returning backend up almost immediately while
 * never hammering one that is genuinely down. Bounded (unlike the main
 * WebSocket store's unlimited backoff in `src/stores/websocket.ts`, which
 * must keep retrying forever because losing it breaks the whole app): past
 * `TERMINAL_RECONNECT_MAX_ATTEMPTS` the terminal gives up and the user takes
 * over via the manual "Reconnect" button, since a single dead terminal tab
 * does not warrant retrying indefinitely.
 */

export const TERMINAL_RECONNECT_MAX_ATTEMPTS = 6
const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 10_000

/** Delay before attempt number `attempt` (1-based). `null` means give up. */
export function terminalReconnectDelayMs(attempt: number): number | null {
  if (attempt < 1 || attempt > TERMINAL_RECONNECT_MAX_ATTEMPTS) return null
  return Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS)
}

/**
 * Whether refocusing a workspace tab should open a new socket for its
 * terminal. Pulled out as pure logic so the double-connect regression can be
 * asserted without mounting `TerminalPanel.vue`: switching away from a
 * workspace while a reconnect backoff is armed, then switching back, used to
 * fire an immediate `connectWs` from the `workspaceId` watcher on top of the
 * timer that was still pending — two sockets racing to replace the same
 * entry. Callers MUST also cancel any pending reconnect timer before acting
 * on this decision (see `TerminalPanel.vue`'s `clearReconnectTimer`); this
 * function only answers "is a fresh connection needed", not "is one already
 * scheduled".
 */
export function shouldConnectOnFocus(state: { wsOpen: boolean; exited: boolean }): boolean {
  return !state.exited && !state.wsOpen
}
