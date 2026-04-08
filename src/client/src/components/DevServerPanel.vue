<script setup lang="ts">
import DevServerLogDialog from 'src/components/DevServerLogDialog.vue'
import { useDevServerStore } from 'src/stores/dev-server'
import { useSettingsStore } from 'src/stores/settings'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  workspace: { id: string; projectPath: string } | null
}>()

const { t } = useI18n()
const devServerStore = useDevServerStore()
const settingsStore = useSettingsStore()

const showLogs = ref(false)
const starting = ref(false)
const stopping = ref(false)

let pollInterval: ReturnType<typeof setInterval> | null = null

const workspaceId = computed(() => props.workspace?.id ?? '')

const hasDevServer = computed(() => {
  if (!props.workspace) return false
  const project = settingsStore.getProjectByPath(props.workspace.projectPath)
  return !!project?.devServer?.startCommand
})

const status = computed(() => {
  if (!workspaceId.value) return null
  return devServerStore.getStatus(workspaceId.value)
})

const statusColor = computed(() => {
  switch (status.value?.status) {
    case 'running':
      return 'green-9'
    case 'starting':
    case 'stopping':
      return 'orange-9'
    case 'error':
      return 'red-9'
    default:
      return 'grey-8'
  }
})

const statusLabel = computed(() => {
  switch (status.value?.status) {
    case 'running':
      return t('devServer.running')
    case 'starting':
      return t('devServer.starting')
    case 'stopping':
      return t('devServer.stopping')
    case 'error':
      return t('devServer.error')
    case 'stopped':
      return t('devServer.stopped')
    default:
      return t('devServer.unknown')
  }
})

const canStart = computed(() => {
  const s = status.value?.status
  return !s || s === 'stopped' || s === 'unknown' || s === 'error'
})

const canStop = computed(() => {
  const s = status.value?.status
  return s === 'running' || s === 'starting'
})

async function start() {
  if (!workspaceId.value) return
  starting.value = true
  try {
    await devServerStore.startDevServer(workspaceId.value)
  } finally {
    starting.value = false
  }
}

async function stop() {
  if (!workspaceId.value) return
  stopping.value = true
  try {
    await devServerStore.stopDevServer(workspaceId.value)
  } finally {
    stopping.value = false
  }
}

function fetchIfNeeded() {
  if (workspaceId.value && hasDevServer.value) {
    devServerStore.fetchStatus(workspaceId.value)
  }
}

function startPolling() {
  stopPolling()
  pollInterval = setInterval(() => {
    fetchIfNeeded()
  }, 30000)
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }
}

watch(workspaceId, () => {
  fetchIfNeeded()
  startPolling()
})

onMounted(() => {
  fetchIfNeeded()
  startPolling()
})

onUnmounted(() => {
  stopPolling()
})
</script>

<template>
  <div class="dd-panel q-px-md q-py-sm">
    <div class="text-caption text-uppercase text-weight-bold text-grey-5 q-mb-xs">
      {{ $t('devServer.title') }}
    </div>

    <template v-if="!workspace">
      <div class="text-caption text-grey-8">
        {{ $t('devServer.noWorkspace') }}
      </div>
    </template>

    <template v-else-if="!hasDevServer">
      <div class="text-caption text-grey-8">
        {{ $t('devServer.notConfigured') }}
        <router-link to="/settings" style="color: #6c63ff;">{{ $t('devServer.goToSettings') }}</router-link>
      </div>
    </template>

    <template v-else-if="status">
      <!-- Status badge -->
      <div class="row items-center q-mb-xs">
        <q-badge :color="statusColor" :label="statusLabel" style="font-size: 10px;" />
        <q-space />
        <!-- Action buttons -->
        <q-btn v-if="canStart" flat round dense icon="play_arrow" size="xs" color="green-5" @click="start" :loading="starting">
          <q-tooltip>{{ $t('tooltip.startDevServer') }}</q-tooltip>
        </q-btn>
        <q-btn v-if="canStop" flat round dense icon="stop" size="xs" color="red-5" @click="stop" :loading="stopping">
          <q-tooltip>{{ $t('tooltip.stopDevServer') }}</q-tooltip>
        </q-btn>
        <q-btn flat round dense icon="article" size="xs" color="grey-5" @click="showLogs = true">
          <q-tooltip>{{ $t('devServer.logs') }}</q-tooltip>
        </q-btn>
      </div>

      <!-- URL when running -->
      <div v-if="status.status === 'running' && status.url" class="text-caption q-mb-xs">
        <a :href="status.url" target="_blank" style="color: #6c63ff;">{{ status.url }}</a>
      </div>

      <!-- Containers -->
      <div v-if="status.containers.length > 0" class="text-caption text-grey-7" style="font-size: 10px;">
        {{ $t('devServer.containers', { count: status.containers.length }, status.containers.length) }}
      </div>

      <!-- Error -->
      <div v-if="status.error" class="text-caption text-red-5">
        {{ status.error }}
      </div>
    </template>

    <!-- Log dialog -->
    <DevServerLogDialog v-if="workspaceId" v-model="showLogs" :workspace-id="workspaceId" />
  </div>
</template>

<style lang="scss" scoped>
.dd-panel {
  min-height: 48px;
}
</style>
