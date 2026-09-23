<template>
  <router-view />
  <MigrationOverlay />
  <NetworkLoginDialog />
</template>

<script setup lang="ts">
import MigrationOverlay from 'src/components/MigrationOverlay.vue'
import NetworkLoginDialog from 'src/components/NetworkLoginDialog.vue'
import {
  attachWorkspaceQueueHost,
  createWorkspaceQueueHost,
  type QueueHostWindow,
} from 'src/services/workspace-queue-bridge'
import { useTemplatesStore } from 'src/stores/templates'
import { useWebSocketStore } from 'src/stores/websocket'
import { useWorkspaceStore } from 'src/stores/workspace'
import { requestNotificationPermission } from 'src/utils/notifications'
import { isWorkspacePane } from 'src/utils/split-workspace'
import { onMounted, onUnmounted } from 'vue'

const wsStore = useWebSocketStore()
const templatesStore = useTemplatesStore()
const workspaceStore = useWorkspaceStore()
// Install before rendering: embedded apps hydrate their mirror before replaying events.
const parentQueues = isWorkspacePane ? (window.parent as QueueHostWindow).koboWorkspaceQueues : undefined
let disposeQueues: (() => void) | undefined
if (parentQueues) {
  disposeQueues = attachWorkspaceQueueHost(workspaceStore, parentQueues)
} else {
  const host = createWorkspaceQueueHost(workspaceStore)
  ;(window as QueueHostWindow).koboWorkspaceQueues = host
  disposeQueues = () => {
    host.dispose()
    delete (window as QueueHostWindow).koboWorkspaceQueues
  }
}

onMounted(() => {
  wsStore.connect()
  templatesStore.fetchTemplates()
  requestNotificationPermission()
})

onUnmounted(() => {
  disposeQueues?.()
  wsStore.disconnect()
})
</script>
