<template>
  <div class="q-pa-sm">
    <div class="row items-center q-mb-sm">
      <span class="text-subtitle2">{{ $t('timeline.title') }}</span>
      <q-space />
      <q-btn flat dense round icon="download" :aria-label="$t('timeline.export')" @click="download" />
    </div>
    <q-list dark dense>
      <q-item v-for="session in sessions" :key="session.id" clickable @click="select(session.id)">
        <q-item-section>
          <q-item-label>{{ session.name || session.model || $t('timeline.unnamed') }}</q-item-label>
          <q-item-label caption>{{ session.status }} · {{ duration(session) }}</q-item-label>
          <div v-if="metricsBySession.get(session.id)" class="row items-center q-gutter-sm q-mt-xs text-caption text-kobo-3">
            <span><q-icon name="build" size="13px" class="q-mr-xs" />{{ $t('timeline.tools', { count: metricsBySession.get(session.id)?.toolCalls ?? 0 }) }}</span>
            <span><q-icon name="token" size="13px" class="q-mr-xs" />{{ formatTokens(metricsBySession.get(session.id)) }}</span>
            <span v-if="(metricsBySession.get(session.id)?.errors ?? 0) > 0" class="text-negative"><q-icon name="error_outline" size="13px" class="q-mr-xs" />{{ $t('timeline.errors', { count: metricsBySession.get(session.id)?.errors ?? 0 }) }}</span>
          </div>
        </q-item-section>
      </q-item>
    </q-list>
  </div>
</template>

<script setup lang="ts">
import type { AgentSession } from 'src/stores/workspace'
import { useWorkspaceStore } from 'src/stores/workspace'
import { computed, onUnmounted, ref, watch } from 'vue'

const props = defineProps<{ workspaceId: string }>()
const store = useWorkspaceStore()
const sessions = computed(() => store.sessions)
interface SessionMetric {
  sessionId: string
  toolCalls: number
  errors: number
  inputTokens: number
  outputTokens: number
}
const metrics = ref<SessionMetric[]>([])
const metricsBySession = computed(() => new Map(metrics.value.map((metric) => [metric.sessionId, metric])))
let metricsRefreshTimer: ReturnType<typeof setTimeout> | null = null
let metricsRequestId = 0

function scheduleMetricsRefresh(): void {
  if (metricsRefreshTimer) clearTimeout(metricsRefreshTimer)
  metricsRefreshTimer = setTimeout(() => void refreshMetrics(), 350)
}

async function refreshMetrics(): Promise<void> {
  metricsRefreshTimer = null
  const requestId = ++metricsRequestId
  try {
    const response = await fetch(`/api/workspaces/${props.workspaceId}/session-metrics`)
    if (!response.ok || requestId !== metricsRequestId) return
    const data = (await response.json()) as { metrics?: SessionMetric[] }
    if (requestId === metricsRequestId) metrics.value = data.metrics ?? []
  } catch {
    if (requestId === metricsRequestId) metrics.value = []
  }
}

watch(
  () => [props.workspaceId, store.sessions.length, store.activityFeeds[props.workspaceId]?.length ?? 0],
  scheduleMetricsRefresh,
  { immediate: true },
)

onUnmounted(() => {
  if (metricsRefreshTimer) clearTimeout(metricsRefreshTimer)
})

function select(id: string) {
  store.selectSession(id)
}
function duration(session: Pick<AgentSession, 'startedAt' | 'endedAt'>) {
  const end = session.endedAt ? new Date(session.endedAt).getTime() : Date.now()
  const ms = Math.max(0, end - new Date(session.startedAt).getTime())
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
}
function formatTokens(metric: SessionMetric | undefined): string {
  if (!metric) return '0'
  const total = metric.inputTokens + metric.outputTokens
  return total >= 1000 ? `${(total / 1000).toFixed(total >= 10_000 ? 0 : 1)}k` : String(total)
}
async function download() {
  const response = await fetch(`/api/workspaces/${props.workspaceId}/diagnostic.json`)
  if (!response.ok) return
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = 'kobo-diagnostic.json'
  link.click()
  URL.revokeObjectURL(url)
}
</script>
