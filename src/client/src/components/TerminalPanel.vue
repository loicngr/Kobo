<template>
  <div class="column" style="height: 100%;">
    <div class="row items-center q-pa-xs q-px-sm text-caption text-kobo-2">
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
        color="kobo-3"
        @click="closeTerminal"
      >
        <q-tooltip>{{ t('terminal.close') }}</q-tooltip>
      </q-btn>
    </div>
    <q-separator dark />

    <div
      v-if="!workspaceId"
      class="col column items-center justify-center text-kobo-3 text-caption"
    >
      {{ t('terminal.noWorkspace') }}
    </div>

    <div
      v-else-if="terminalError"
      class="col column items-center justify-center text-red-4 text-caption"
    >
      <q-icon name="error" size="24px" class="q-mb-sm" />
      {{ t('terminal.error') }}: {{ terminalError }}
      <q-btn flat dense no-caps color="primary" class="q-mt-sm" @click="reopenTerminal">
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
      <q-btn flat dense no-caps color="primary" class="q-mt-sm" @click="reopenTerminal">
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
        color="primary"
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
import type { TerminalEntry } from 'src/services/terminal-registry'
import {
  bumpTerminalState,
  clearReconnectTimer,
  disposeTerminalEntry,
  terminalMap,
  terminalStateVersion,
} from 'src/services/terminal-registry'
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

const containerRef = ref<HTMLElement | null>(null)
let currentAttachedId: string | null = null
let resizeObserver: ResizeObserver | null = null

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
        bumpTerminalState()
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
        bumpTerminalState()
      } else if (msg.type === 'exited') {
        entry.exited = true
        entry.exitCode = msg.code ?? null
        bumpTerminalState()
      }
    }
  }

  ws.onclose = () => {
    entry.ws = null
    scheduleReconnect(wid, entry)
  }

  ws.onerror = () => {
    entry.error = t('terminal.error')
    bumpTerminalState()
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
  bumpTerminalState()
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

  // xterm.js parses `theme` colours with its own hex/rgb parser for canvas
  // rendering — it never resolves `var(--...)`, so the design tokens are read
  // to their literal value here instead of hardcoding hex in source.
  const rootStyle = getComputedStyle(document.documentElement)
  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 12,
    fontFamily: 'var(--kobo-font-mono)',
    theme: {
      background: rootStyle.getPropertyValue('--kobo-bg-deep').trim(),
      foreground: rootStyle.getPropertyValue('--kobo-text-2').trim(),
      cursor: rootStyle.getPropertyValue('--kobo-accent').trim(),
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
  bumpTerminalState()
  attachTerminal(wid, entry)
  connectWs(wid, entry)
}

function closeTerminal() {
  const wid = workspaceId.value
  if (!wid) return

  // Detach from DOM only if this terminal is currently displayed
  if (currentAttachedId === wid) {
    detachTerminal()
  }

  disposeTerminalEntry(wid)
}

function reopenTerminal() {
  const wid = workspaceId.value
  if (!wid) return

  disposeTerminalEntry(wid)
  currentAttachedId = null
  bumpTerminalState()
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
  bumpTerminalState()
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
