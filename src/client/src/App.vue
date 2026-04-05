<script setup lang="ts">
import { useWebSocketStore } from 'src/stores/websocket'
import { onMounted, onUnmounted } from 'vue'

const wsStore = useWebSocketStore()

onMounted(() => {
  wsStore.connect()
})

onUnmounted(() => {
  wsStore.disconnect()
})
</script>

<template>
  <router-view />
</template>
