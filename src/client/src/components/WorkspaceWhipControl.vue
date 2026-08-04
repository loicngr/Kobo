<template>
  <q-btn
    v-if="showButton"
    dense
    no-caps
    size="sm"
    color="deep-orange-5"
    icon="sports_martial_arts"
    :flat="!active"
    :unelevated="active"
    :label="t('whip.button')"
    class="q-mr-xs"
    @click="toggleWhip"
  >
    <q-tooltip>{{ t('whip.tooltip') }}</q-tooltip>
  </q-btn>
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
import { isBusyStatus } from 'src/utils/workspace-status'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
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
const showButton = computed(() => active.value || (props.running && props.sessionId !== null))
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

function handleCrack(): void {
  const now = Date.now()
  if (props.running || now <= allowStoppedUntil) {
    allowStoppedUntil = now + SOFT_INTERRUPT_GRACE_MS
    if (!props.running) closeWhenInterruptGraceExpires()
  }
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

onBeforeUnmount(deactivate)
</script>
