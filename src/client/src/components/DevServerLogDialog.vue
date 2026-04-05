<script setup lang="ts">
import { useDevServerStore } from 'src/stores/dev-server'
import { nextTick, onUnmounted, ref, watch } from 'vue'

const props = defineProps<{
  modelValue: boolean
  workspaceId: string
}>()

defineEmits<{ 'update:modelValue': [value: boolean] }>()

const devServerStore = useDevServerStore()
const logs = ref('')
const loading = ref(false)
const logContainer = ref<HTMLElement | null>(null)

let refreshInterval: ReturnType<typeof setInterval> | null = null

async function refresh() {
  if (!props.workspaceId) return
  loading.value = true
  try {
    logs.value = await devServerStore.fetchLogs(props.workspaceId)
    await nextTick()
    scrollToBottom()
  } finally {
    loading.value = false
  }
}

function scrollToBottom() {
  if (logContainer.value) {
    logContainer.value.scrollTop = logContainer.value.scrollHeight
  }
}

function startAutoRefresh() {
  stopAutoRefresh()
  refreshInterval = setInterval(() => {
    refresh()
  }, 5000)
}

function stopAutoRefresh() {
  if (refreshInterval) {
    clearInterval(refreshInterval)
    refreshInterval = null
  }
}

watch(
  () => props.modelValue,
  (isOpen) => {
    if (isOpen) {
      refresh()
      startAutoRefresh()
    } else {
      stopAutoRefresh()
    }
  },
)

onUnmounted(() => {
  stopAutoRefresh()
})
</script>

<template>
  <q-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)">
    <q-card class="text-grey-3" style="min-width: 700px; max-width: 900px; max-height: 80vh; background: #1e1e3a;">
      <q-card-section class="row items-center">
        <div class="text-h6">Logs Dev Server</div>
        <q-space />
        <q-btn flat round dense icon="refresh" color="grey-5" @click="refresh" :loading="loading" />
        <q-btn flat round dense icon="close" color="grey-5" @click="$emit('update:modelValue', false)" />
      </q-card-section>

      <q-separator dark />

      <q-card-section class="log-content" ref="logContainer">
        <pre class="log-text rounded-borders q-pa-md">{{ logs || 'No logs available' }}</pre>
      </q-card-section>
    </q-card>
  </q-dialog>
</template>

<style lang="scss" scoped>
.log-content {
  max-height: 60vh;
  overflow-y: auto;
}

.log-text {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 11px;
  color: #ccc;
  background: #0d0d1a;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
}
</style>
