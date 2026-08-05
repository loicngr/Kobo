<template>
  <WhipOverlay
    v-if="active"
    :sound-enabled="settingsStore.global.audioNotifications"
    :sound-volume="settingsStore.global.audioNotificationVolume"
    @crack="handleCrack"
    @closed="deactivate"
  />
</template>

<script setup lang="ts">
import { Notify } from 'quasar'
import WhipOverlay from 'src/components/WhipOverlay.vue'
import { useSettingsStore } from 'src/stores/settings'
import { useWebSocketStore } from 'src/stores/websocket'
import { useWorkspaceStore } from 'src/stores/workspace'
import { createWhipCrackCoordinator, type WhipCrackCoordinator } from 'src/utils/whip-crack'
import { detectWhipShortcutPlatform, matchesWhipShortcut } from 'src/utils/whip-shortcut'
import { isBusyStatus } from 'src/utils/workspace-status'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  workspaceId: string
  sessionId: string | null
  running: boolean
}>()

const { t } = useI18n()
const workspaceStore = useWorkspaceStore()
const websocketStore = useWebSocketStore()
const settingsStore = useSettingsStore()
const active = ref(false)
const shortcutPlatform = detectWhipShortcutPlatform()
const SOFT_INTERRUPT_GRACE_MS = 1_000
let coordinator: WhipCrackCoordinator | null = null
let stoppedTimer: number | null = null
let allowStoppedUntil = 0

function clearStoppedTimer(): void {
  if (stoppedTimer === null) return
  window.clearTimeout(stoppedTimer)
  stoppedTimer = null
}

function deactivate(): void {
  clearStoppedTimer()
  allowStoppedUntil = 0
  active.value = false
  coordinator?.dispose()
  coordinator = null
}

function closeWhenInterruptGraceExpires(): void {
  clearStoppedTimer()
  const remaining = allowStoppedUntil - Date.now()
  if (remaining <= 0) {
    deactivate()
    return
  }
  stoppedTimer = window.setTimeout(deactivate, remaining)
}

function activate(): void {
  if (!props.running || !props.sessionId) return
  const target = { workspaceId: props.workspaceId, sessionId: props.sessionId }
  const phrases = [1, 2, 3, 4, 5].map((number) => t(`whip.phrase${number}`))
  coordinator = createWhipCrackCoordinator(target, phrases, {
    isAgentRunning(workspaceId) {
      const workspace = [...workspaceStore.workspaces, ...workspaceStore.archivedWorkspaces].find(
        (candidate) => candidate.id === workspaceId,
      )
      return isBusyStatus(workspace?.status)
    },
    interruptAgent: (workspaceId) => workspaceStore.interruptAgent(workspaceId),
    sendMessage: (workspaceId, message, sessionId) => websocketStore.sendChatMessage(workspaceId, message, sessionId),
    wait: (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds)),
    random: Math.random,
    now: Date.now,
    onError() {
      Notify.create({
        type: 'negative',
        message: t('whip.dispatchFailed'),
        position: 'top',
        timeout: 5_000,
      })
    },
  })
  active.value = true
}

function toggleWhip(): void {
  if (active.value) deactivate()
  else activate()
}

function onShortcutKeydown(event: KeyboardEvent): void {
  if (event.repeat || !settingsStore.global.whipEnabled) return
  if (!matchesWhipShortcut(event, settingsStore.global.whipShortcut, shortcutPlatform)) return
  if (!active.value && (!props.running || !props.sessionId)) return
  event.preventDefault()
  toggleWhip()
}

function handleCrack(): void {
  const now = Date.now()
  if (props.running) {
    allowStoppedUntil = now + SOFT_INTERRUPT_GRACE_MS
  } else if (now > allowStoppedUntil) {
    deactivate()
    return
  }
  if (!props.running) closeWhenInterruptGraceExpires()
  void coordinator?.enqueue()
}

watch(
  () => [props.workspaceId, props.sessionId] as const,
  ([workspaceId, sessionId], [previousWorkspaceId, previousSessionId]) => {
    if (workspaceId !== previousWorkspaceId || sessionId !== previousSessionId) deactivate()
  },
)

watch(
  () => props.running,
  (running) => {
    if (running) {
      clearStoppedTimer()
      return
    }
    if (!active.value) return
    closeWhenInterruptGraceExpires()
  },
)

watch(
  () => settingsStore.global.whipEnabled,
  (enabled) => {
    if (!enabled) deactivate()
  },
)

onMounted(() => window.addEventListener('keydown', onShortcutKeydown))

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onShortcutKeydown)
  deactivate()
})
</script>
