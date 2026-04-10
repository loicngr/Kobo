<script setup lang="ts">
import { useWebSocketStore } from 'src/stores/websocket'
import { useTemplatesStore } from 'src/stores/templates'
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
</template>
