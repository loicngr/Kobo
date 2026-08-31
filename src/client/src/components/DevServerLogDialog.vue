<template>
  <q-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)">
    <q-card class="text-kobo-1" style="min-width: 700px; max-width: 900px; max-height: 80vh; background: var(--kobo-surface);">
      <q-card-section class="row items-center">
        <div class="text-h6">{{ t('devServer.logDialog.title') }}</div>
        <q-space />
        <q-btn flat round dense icon="refresh" color="kobo-2" @click="refresh" :loading="loading">
          <q-tooltip>{{ $t('tooltip.refreshLogs') }}</q-tooltip>
        </q-btn>
        <q-btn flat round dense icon="close" color="kobo-2" @click="$emit('update:modelValue', false)">
          <q-tooltip>{{ $t('tooltip.closeDialog') }}</q-tooltip>
        </q-btn>
      </q-card-section>

      <q-separator dark />

      <q-card-section class="log-content" ref="logContainer">
        <pre class="log-text rounded-borders q-pa-md">{{ logs || t('devServer.logDialog.empty') }}</pre>
      </q-card-section>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { useDevServerStore } from 'src/stores/dev-server'
import { nextTick, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  modelValue: boolean
  workspaceId: string
}>()

defineEmits<{ 'update:modelValue': [value: boolean] }>()

const devServerStore = useDevServerStore()
const { t } = useI18n()
const logs = ref('')
const loading = ref(false)
const logContainer = ref<HTMLElement | null>(null)

let refreshTimer: ReturnType<typeof setTimeout> | null = null
let refreshGeneration = 0

async function refresh() {
  if (!props.workspaceId || loading.value) return
  const workspaceId = props.workspaceId
  const generation = refreshGeneration
  loading.value = true
  try {
    const nextLogs = await devServerStore.fetchLogs(workspaceId)
    if (generation !== refreshGeneration || workspaceId !== props.workspaceId || !props.modelValue) return
    logs.value = nextLogs
    await nextTick()
    scrollToBottom()
  } finally {
    loading.value = false
    scheduleRefresh(generation)
  }
}

function scrollToBottom() {
  if (logContainer.value) {
    logContainer.value.scrollTop = logContainer.value.scrollHeight
  }
}

function startAutoRefresh() {
  stopAutoRefresh()
  refreshGeneration++
  void refresh()
}

function stopAutoRefresh() {
  refreshGeneration++
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
}

function scheduleRefresh(generation: number) {
  if (generation !== refreshGeneration || !props.modelValue || document.hidden) return
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void refresh()
  }, 5000)
}

function onVisibilityChange() {
  if (!props.modelValue) return
  if (document.hidden) stopAutoRefresh()
  else startAutoRefresh()
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

watch(
  () => props.workspaceId,
  () => {
    if (props.modelValue) startAutoRefresh()
  },
)

document.addEventListener('visibilitychange', onVisibilityChange)

onUnmounted(() => {
  stopAutoRefresh()
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<style lang="scss" scoped>
.log-content {
  max-height: 60vh;
  overflow-y: auto;
}

.log-text {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 11px;
  color: var(--kobo-text-2);
  background: var(--kobo-bg-deep);
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
}
</style>
