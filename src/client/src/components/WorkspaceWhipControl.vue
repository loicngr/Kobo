<template>
  <WhipOverlay
    v-if="active"
    :sound-enabled="settingsStore.global.audioNotifications"
    :sound-volume="settingsStore.global.whipVolume"
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
import { DEFAULT_TOAST_TIMEOUT_MS } from 'src/utils/notification-timeout'
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
let coordinator: WhipCrackCoordinator | null = null
const coordinatorLifecycles = new Map<
  WhipCrackCoordinator,
  { pendingActions: Set<Promise<void>>; closeOnSettle: boolean }
>()

function deactivate(): void {
  active.value = false
  if (coordinator) {
    coordinatorLifecycles.delete(coordinator)
    coordinator.dispose()
  }
  coordinator = null
}

function suspendAfterSessionEnd(): void {
  active.value = false
  const currentCoordinator = coordinator
  const lifecycle = currentCoordinator ? coordinatorLifecycles.get(currentCoordinator) : undefined
  if (!currentCoordinator || !lifecycle || lifecycle.pendingActions.size === 0) {
    deactivate()
    return
  }
  lifecycle.closeOnSettle = true
}

function trackAction(owner: WhipCrackCoordinator, action: Promise<void>): void {
  const lifecycle = coordinatorLifecycles.get(owner)
  if (!lifecycle || lifecycle.pendingActions.has(action)) return
  lifecycle.pendingActions.add(action)

  const settle = () => {
    const currentLifecycle = coordinatorLifecycles.get(owner)
    if (!currentLifecycle?.pendingActions.delete(action)) return
    if (currentLifecycle.pendingActions.size === 0 && currentLifecycle.closeOnSettle && coordinator === owner) {
      deactivate()
    }
  }
  void action.then(settle, settle).catch(() => undefined)
}

function activate(): void {
  if (!props.running || !props.sessionId) return
  const target = { workspaceId: props.workspaceId, sessionId: props.sessionId }
  const phrases = [1, 2, 3, 4, 5].map((number) => t(`whip.phrase${number}`))
  const activatedCoordinator = createWhipCrackCoordinator(target, phrases, {
    isAgentRunning(workspaceId) {
      const workspace = [...workspaceStore.workspaces, ...workspaceStore.archivedWorkspaces].find(
        (candidate) => candidate.id === workspaceId,
      )
      return isBusyStatus(workspace?.status)
    },
    interruptAgent: (workspaceId) =>
      workspaceStore.interruptAgent(workspaceId, {
        expectedSessionId: target.sessionId,
        disableAutoLoop: true,
      }),
    sendMessage: (workspaceId, message, sessionId) => websocketStore.sendChatMessage(workspaceId, message, sessionId),
    wait: (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds)),
    random: Math.random,
    now: Date.now,
    onError() {
      Notify.create({
        type: 'negative',
        message: t('whip.dispatchFailed'),
        position: 'top',
        timeout: DEFAULT_TOAST_TIMEOUT_MS,
      })
    },
  })
  coordinator = activatedCoordinator
  coordinatorLifecycles.set(activatedCoordinator, { pendingActions: new Set(), closeOnSettle: false })
  active.value = true
}

function toggleWhip(): void {
  if (active.value) deactivate()
  else activate()
}

function onShortcutKeydown(event: KeyboardEvent): void {
  if (!settingsStore.global.whipEnabled) return
  if (!matchesWhipShortcut(event, settingsStore.global.whipShortcut, shortcutPlatform)) return
  event.preventDefault()
  event.stopImmediatePropagation()
  if (event.repeat || (!active.value && (!props.running || !props.sessionId))) return
  toggleWhip()
}

function handleCrack(): void {
  const owner = coordinator
  if (!owner) return
  const lifecycle = coordinatorLifecycles.get(owner)
  if (!lifecycle) return
  if (!props.running && lifecycle.pendingActions.size === 0) {
    deactivate()
    return
  }
  const action = owner.enqueue()
  trackAction(owner, action)
  if (!props.running) lifecycle.closeOnSettle = true
}

watch(
  () => [props.workspaceId, props.sessionId] as const,
  ([workspaceId, sessionId], [previousWorkspaceId, previousSessionId]) => {
    if (workspaceId !== previousWorkspaceId) {
      deactivate()
      return
    }
    if (sessionId === previousSessionId) return
    if (sessionId === null && previousSessionId !== null) {
      suspendAfterSessionEnd()
      return
    }
    deactivate()
  },
)

watch(
  () => props.running,
  (running) => {
    if (running) return
    if (!active.value) return
    const currentCoordinator = coordinator
    const lifecycle = currentCoordinator ? coordinatorLifecycles.get(currentCoordinator) : undefined
    if (!lifecycle || lifecycle.pendingActions.size === 0) {
      deactivate()
      return
    }
    lifecycle.closeOnSettle = true
  },
)

watch(
  () => settingsStore.global.whipEnabled,
  (enabled) => {
    if (!enabled) deactivate()
  },
)

onMounted(() => window.addEventListener('keydown', onShortcutKeydown, true))

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onShortcutKeydown, true)
  deactivate()
})
</script>
