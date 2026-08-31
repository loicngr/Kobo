<template>
  <div class="column" style="height: 100%;">
    <div class="row items-center q-pa-xs q-px-sm text-caption text-grey-5">
      <q-icon name="terminal" size="14px" class="q-mr-xs" />
      <span>{{ t('terminal.title') }}</span>
      <q-space />
      <q-btn
        v-if="isOpen"
        flat
        dense
        round
        size="xs"
        icon="close"
        color="grey-6"
        @click="closeTerminal"
      >
        <q-tooltip>{{ t('terminal.close') }}</q-tooltip>
      </q-btn>
    </div>
    <q-separator dark />

    <div
      v-if="!workspaceId"
      class="col column items-center justify-center text-grey-7 text-caption"
    >
      {{ t('terminal.noWorkspace') }}
    </div>

    <div
      v-else-if="terminalError"
      class="col column items-center justify-center text-red-4 text-caption"
    >
      <q-icon name="error" size="24px" class="q-mb-sm" />
      {{ t('terminal.error') }}: {{ terminalError }}
      <q-btn flat dense no-caps color="indigo-4" class="q-mt-sm" @click="reopenTerminal">
        {{ t('terminal.open') }}
      </q-btn>
    </div>

    <div v-else-if="isDisconnected" class="col column items-center justify-center terminal-panel__state">
      <q-icon name="link_off" size="20px" class="text-warning" />
      <div>{{ t('terminal.disconnected') }}</div>
      <div v-if="reconnectAttempt > 0 && reconnectAttempt <= reconnectMax" class="text-caption">
        {{ t('terminal.reconnecting', { attempt: reconnectAttempt, max: reconnectMax }) }}
      </div>
      <q-btn dense flat no-caps icon="refresh" :label="t('terminal.reconnect')" @click="reconnectNow" />
    </div>

    <div
      v-else-if="hasExited"
      class="col column items-center justify-center text-amber-6 text-caption"
    >
      <q-icon name="info" size="24px" class="q-mb-sm" />
      {{ t('terminal.exited') }}
      <q-btn flat dense no-caps color="indigo-4" class="q-mt-sm" @click="reopenTerminal">
        {{ t('terminal.open') }}
      </q-btn>
    </div>

    <div
      v-else-if="!currentEntry"
      class="col column items-center justify-center"
    >
      <q-btn
        flat
        dense
        no-caps
        color="indigo-4"
        icon="terminal"
        :label="t('terminal.open')"
        :disable="!hasWorktree || isArchived"
        @click="openTerminal"
      >
        <q-tooltip v-if="!hasWorktree">{{ t('terminal.noWorktree') }}</q-tooltip>
      </q-btn>
    </div>

    <div
      v-show="isOpen"
      ref="containerRef"
      class="col"
      style="overflow: hidden;"
    />
  </div>
</template>

<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useWorkspaceStore } from 'src/stores/workspace'
import { appendTokenToWsUrl, getToken } from 'src/utils/auth-token'
import {
  shouldConnectOnFocus,
  TERMINAL_RECONNECT_MAX_ATTEMPTS,
  terminalReconnectDelayMs,
} from 'src/utils/terminal-reconnect'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const store = useWorkspaceStore()

interface TerminalEntry {
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

// Singleton map — survives component remount
const terminalMap = new Map<string, TerminalEntry>()

const containerRef = ref<HTMLElement | null>(null)
let currentAttachedId: string | null = null
let resizeObserver: ResizeObserver | null = null

// Force reactivity for terminal state changes
const terminalStateVersion = ref(0)

const workspace = computed(() => store.selectedWorkspace)
const workspaceId = computed(() => store.selectedWorkspaceId)

const hasWorktree = computed(() => {
  const ws = workspace.value
  if (!ws) return false
  return ws.status !== 'created'
})

const isArchived = computed(() => !!workspace.value?.archivedAt)

const currentEntry = computed(() => {
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  terminalStateVersion.value
  if (!workspaceId.value) return null
  return terminalMap.get(workspaceId.value) ?? null
})

const isOpen = computed(() => !!currentEntry.value && !currentEntry.value.exited && !currentEntry.value.disconnected)
const hasExited = computed(() => !!currentEntry.value?.exited)
const isDisconnected = computed(() => !!currentEntry.value?.disconnected)
const reconnectAttempt = computed(() => currentEntry.value?.reconnectAttempt ?? 0)
const reconnectMax = TERMINAL_RECONNECT_MAX_ATTEMPTS
const terminalError = computed(() => currentEntry.value?.error ?? null)

function bumpState() {
  terminalStateVersion.value++
}

function connectWs(wid: string, entry: TerminalEntry) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(appendTokenToWsUrl(`${protocol}//${window.location.host}/ws/terminal/${wid}`, getToken()))
  ws.binaryType = 'arraybuffer'
  entry.ws = ws

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'create' }))
  }

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      entry.terminal.write(new Uint8Array(event.data))
    } else {
      let msg: { type: string; message?: string; code?: number }
      try {
        msg = JSON.parse(event.data as string)
      } catch {
        return // Not JSON — ignore
      }

      if (msg.type === 'ready') {
        entry.error = null
        entry.disconnected = false
        entry.reconnectAttempt = 0
        bumpState()
        try {
          entry.fitAddon.fit()
        } catch {
          /* terminal not yet in DOM */
        }
        const dims = entry.fitAddon.proposeDimensions()
        if (dims && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }))
        }
      } else if (msg.type === 'error') {
        entry.error = msg.message ?? 'Unknown error'
        bumpState()
      } else if (msg.type === 'exited') {
        entry.exited = true
        entry.exitCode = msg.code ?? null
        bumpState()
      }
    }
  }

  ws.onclose = () => {
    entry.ws = null
    scheduleReconnect(wid, entry)
  }

  ws.onerror = () => {
    entry.error = t('terminal.error')
    bumpState()
  }

  // Dispose any listener from a previous connectWs() call on this same
  // xterm.Terminal instance — the terminal itself is reused across
  // reconnects (only `entry.ws` is replaced), so without this a reconnect
  // stacks a second onData listener and every keystroke gets sent twice.
  entry.onDataDisposable?.dispose()
  entry.onDataDisposable = entry.terminal.onData((data: string) => {
    if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
      entry.ws.send(new TextEncoder().encode(data))
    }
  })
}

// Shared cleanup gesture — reused at every site that must not leave a stale
// reconnect timer armed: closing the terminal, reopening it, the manual
// "Reconnect" button, and refocusing a workspace tab. Repeating the inline
// `if (entry.reconnectTimer) clearTimeout(...)` at four call sites is exactly
// how one of them gets missed; centralizing it here means there's only one
// place to get right.
function clearReconnectTimer(entry: TerminalEntry) {
  if (entry.reconnectTimer) {
    clearTimeout(entry.reconnectTimer)
    entry.reconnectTimer = undefined
  }
}

// Declared with `function` (hoisted) — connectWs's onclose calls this, and
// this calls back into connectWs on the retry timer, so neither can be a
// `const` without breaking the mutual reference.
function scheduleReconnect(wid: string, target: TerminalEntry) {
  // A shell that exited on its own must NOT be respawned — only a lost
  // connection is retried.
  if (target.exited) return
  const attempt = target.reconnectAttempt + 1
  const delay = terminalReconnectDelayMs(attempt)
  if (delay === null) return // give up; the user gets a manual Reconnect button
  target.reconnectAttempt = attempt
  target.disconnected = true
  bumpState()
  // Light jitter (same 0.8-1.2x spread as the main WS store's
  // `_scheduleReconnect`), applied here rather than inside
  // `terminalReconnectDelayMs` so that function stays a deterministic,
  // exactly-testable schedule. Without it, several workspaces with a
  // terminal open would all resume in lockstep after one backend restart.
  const jitteredDelay = Math.round(delay * (0.8 + Math.random() * 0.4))
  target.reconnectTimer = setTimeout(() => {
    if (target.exited) return
    connectWs(wid, target)
  }, jitteredDelay)
}

function openTerminal() {
  const wid = workspaceId.value
  if (!wid || !hasWorktree.value || isArchived.value) return
  if (terminalMap.has(wid)) return

  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 12,
    fontFamily: "'Roboto Mono', monospace",
    theme: {
      background: '#16162a',
      foreground: '#cccccc',
      cursor: '#6c63ff',
    },
    scrollback: 1000,
  })

  const fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)

  const container = document.createElement('div')
  container.style.width = '100%'
  container.style.height = '100%'

  const entry: TerminalEntry = {
    terminal,
    fitAddon,
    ws: null,
    exited: false,
    exitCode: null,
    error: null,
    container,
    opened: false,
    disconnected: false,
    reconnectAttempt: 0,
  }

  terminalMap.set(wid, entry)
  bumpState()
  attachTerminal(wid, entry)
  connectWs(wid, entry)
}

function closeTerminal() {
  const wid = workspaceId.value
  if (!wid) return

  const entry = terminalMap.get(wid)
  if (!entry) return

  // Detach from DOM only if this terminal is currently displayed
  if (currentAttachedId === wid) {
    detachTerminal()
  }

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
  terminalMap.delete(wid)
  bumpState()
}

function reopenTerminal() {
  const wid = workspaceId.value
  if (!wid) return

  const old = terminalMap.get(wid)
  if (old) {
    clearReconnectTimer(old)
    if (old.ws) {
      old.ws.onclose = null
      if (old.ws.readyState === WebSocket.OPEN) old.ws.close()
    }
    old.terminal.dispose()
    terminalMap.delete(wid)
  }
  currentAttachedId = null
  bumpState()
  nextTick(() => openTerminal())
}

function reconnectNow() {
  const wid = workspaceId.value
  const entry = currentEntry.value
  if (!wid || !entry) return
  clearReconnectTimer(entry)
  entry.reconnectAttempt = 0
  connectWs(wid, entry)
}

function attachTerminal(wid: string, entry: TerminalEntry) {
  if (!containerRef.value) return
  if (currentAttachedId === wid) return

  // Detach any previously attached terminal
  detachTerminal()

  currentAttachedId = wid

  // Open xterm into its persistent container (only once)
  if (!entry.opened) {
    entry.terminal.open(entry.container)
    entry.opened = true
  }

  // Move the persistent container into the visible DOM
  containerRef.value.appendChild(entry.container)
  // Double nextTick: first for Vue to update v-show, second to fit after layout
  nextTick(() => nextTick(() => entry.fitAddon.fit()))
}

function detachTerminal() {
  if (!currentAttachedId) return
  const entry = terminalMap.get(currentAttachedId)
  if (entry?.container.parentElement) {
    entry.container.parentElement.removeChild(entry.container)
  }
  currentAttachedId = null
}

watch(workspaceId, (newId, oldId) => {
  if (oldId) detachTerminal()
  if (newId) {
    const entry = terminalMap.get(newId)
    if (entry) {
      nextTick(() => {
        attachTerminal(newId, entry)
        // A reconnect backoff may still be armed from before this workspace
        // tab lost focus. Cancel it before deciding whether to connect now —
        // otherwise the timer fires later and races this immediate call,
        // opening two sockets for the same entry.
        clearReconnectTimer(entry)
        if (shouldConnectOnFocus({ wsOpen: entry.ws?.readyState === WebSocket.OPEN, exited: entry.exited })) {
          connectWs(newId, entry)
        }
      })
    }
  }
  bumpState()
})

onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    if (!workspaceId.value) return
    const entry = terminalMap.get(workspaceId.value)
    if (entry && currentAttachedId === workspaceId.value) {
      entry.fitAddon.fit()
      const dims = entry.fitAddon.proposeDimensions()
      if (dims && entry.ws?.readyState === WebSocket.OPEN) {
        entry.ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }))
      }
    }
  })

  if (containerRef.value) {
    resizeObserver.observe(containerRef.value)
  }

  if (workspaceId.value) {
    const entry = terminalMap.get(workspaceId.value)
    if (entry) {
      nextTick(() => attachTerminal(workspaceId.value!, entry))
    }
  }
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  detachTerminal()
})
</script>

<style lang="scss" scoped>
.terminal-panel__state {
  gap: var(--kobo-space-sm);
  padding: var(--kobo-space-2xl);
  color: var(--kobo-text-3);
}
</style>
