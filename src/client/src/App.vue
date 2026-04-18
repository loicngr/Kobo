<script setup lang="ts">
import MigrationOverlay from 'src/components/MigrationOverlay.vue'
import { useTemplatesStore } from 'src/stores/templates'
import { useWebSocketStore } from 'src/stores/websocket'
import { requestNotificationPermission } from 'src/utils/notifications'
import { onMounted, onUnmounted } from 'vue'

const wsStore = useWebSocketStore()
const templatesStore = useTemplatesStore()

onMounted(() => {
  wsStore.connect()
  templatesStore.fetchTemplates()
  requestNotificationPermission()
})

onUnmounted(() => {
  wsStore.disconnect()
})
</script>

<template>
  <router-view />
  <MigrationOverlay />
</template>
