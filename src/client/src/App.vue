<script setup lang="ts">
import { useWebSocketStore } from 'src/stores/websocket'
import { requestNotificationPermission } from 'src/utils/notifications'
import { onMounted, onUnmounted } from 'vue'

const wsStore = useWebSocketStore()

onMounted(() => {
  wsStore.connect()
  requestNotificationPermission()
})

onUnmounted(() => {
  wsStore.disconnect()
})
</script>

<template>
  <router-view />
</template>
