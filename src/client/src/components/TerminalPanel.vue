<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useWorkspaceStore } from 'src/stores/workspace'
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

const isOpen = computed(() => !!currentEntry.value && !currentEntry.value.exited)
const hasExited = computed(() => !!currentEntry.value?.exited)
const terminalError = computed(() => currentEntry.value?.error ?? null)

function bumpState() {
  terminalStateVersion.value++
}

function connectWs(wid: string, entry: TerminalEntry) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws/terminal/${wid}`)
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
  }

  ws.onerror = () => {
    entry.error = t('terminal.error')
    bumpState()
  }

  entry.terminal.onData((data: string) => {
    if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
      entry.ws.send(new TextEncoder().encode(data))
    }
  })
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

  if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
    entry.ws.close()
  }
  entry.terminal.dispose()
  terminalMap.delete(wid)
  bumpState()
}

function reopenTerminal() {
  const wid = workspaceId.value
  if (!wid) return

  const old = terminalMap.get(wid)
  if (old) {
    if (old.ws && old.ws.readyState === WebSocket.OPEN) {
      old.ws.close()
    }
    old.terminal.dispose()
    terminalMap.delete(wid)
  }
  currentAttachedId = null
  bumpState()
  nextTick(() => openTerminal())
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
        if (!entry.ws || entry.ws.readyState !== WebSocket.OPEN) {
          if (!entry.exited) {
            connectWs(newId, entry)
          }
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
