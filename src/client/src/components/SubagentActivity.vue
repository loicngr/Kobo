<template>
  <div class="subagent-activity q-mt-sm" :aria-label="t('subagents.activity')">
    <div v-if="loading && items.length === 0" class="text-caption text-kobo-3">
      <q-spinner size="sm" /> {{ t('activity.loading_older') }}
    </div>
    <div v-else-if="error" role="alert" class="text-caption text-negative">
      {{ error }}
      <q-btn flat dense :label="t('common.retry')" @click="loadInitial" />
    </div>
    <div v-else-if="items.length === 0" class="text-caption text-kobo-3">{{ t('subagents.noActivity') }}</div>
    <div v-else class="subagent-activity-list">
      <q-btn
        v-if="hasMore"
        flat
        dense
        class="self-start"
        :loading="loading"
        :label="t('prPicker.loadMore')"
        @click="loadOlder"
      />
      <div v-for="item in items" :key="itemKey(item)" class="subagent-activity-item">
        <TextMessageItem v-if="item.type === 'text'" :item="item" />
        <ToolCallItem v-else-if="item.type === 'tool'" :item="item" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { type ConversationItem, foldEvents } from 'src/services/agent-event-view'
import { belongsToSubagent, subagentActivityEvents } from 'src/services/subagent-activity'
import { useAgentStreamStore } from 'src/stores/agent-stream'
import type { Subagent } from 'src/stores/workspace'
import type { AgentEvent } from 'src/types/agent-event'
import { apiFetchResponse, apiResponseError } from 'src/utils/api'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import TextMessageItem from './items/TextMessageItem.vue'
import ToolCallItem from './items/ToolCallItem.vue'

interface FetchedEvent {
  id: string
  type: string
  payload: unknown
  sessionId: string | null
  createdAt: string
}

const HISTORY_PAGE_SIZE = 100
const props = defineProps<{ workspaceId: string; subagent: Subagent }>()
const stream = useAgentStreamStore()
const { t } = useI18n()
const history = ref<FetchedEvent[]>([])
const hasMore = ref(false)
const loading = ref(false)
const error = ref('')

const items = computed(() => {
  const liveEvents = stream.eventsFor(props.workspaceId)
  const liveTimestamps = stream.timestampsFor(props.workspaceId)
  const liveSessionIds = stream.sessionIdsFor(props.workspaceId)
  const liveEventIds = stream.eventIdsFor(props.workspaceId)
  const merged = new Map<string, { event: AgentEvent; timestamp: string }>()

  for (const event of history.value) {
    if (event.type !== 'agent:event' || !isAgentEvent(event.payload)) continue
    merged.set(event.id, { event: event.payload, timestamp: event.createdAt })
  }
  for (let index = 0; index < liveEvents.length; index++) {
    const event = liveEvents[index]
    if (!event || !belongsToSubagent(event, props.subagent)) continue
    if (props.subagent.sessionId && liveSessionIds[index] !== props.subagent.sessionId) continue
    merged.set(liveEventIds[index] ?? `live:${index}`, { event, timestamp: liveTimestamps[index] ?? '' })
  }

  const ordered = [...merged.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  const events = subagentActivityEvents(
    ordered.map((entry) => entry.event),
    ordered.map(() => props.subagent.sessionId ?? null),
    props.subagent,
  )
  const timestamps = ordered
    .filter((entry) => belongsToSubagent(entry.event, props.subagent))
    .map((entry) => entry.timestamp)
  return foldEvents(events, timestamps, props.subagent.status === 'running').filter(
    (item): item is Extract<ConversationItem, { type: 'text' | 'tool' }> =>
      item.type === 'text' || item.type === 'tool',
  )
})

function isAgentEvent(payload: unknown): payload is AgentEvent {
  return typeof payload === 'object' && payload !== null && 'kind' in payload
}

function historyUrl(before?: string): string {
  const params = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE) })
  if (props.subagent.sessionId) params.set('session', props.subagent.sessionId)
  if (props.subagent.toolUseId) params.set('subagentToolCallId', props.subagent.toolUseId)
  if (props.subagent.threadIds?.length) params.set('subagentThreadIds', props.subagent.threadIds.join(','))
  if (before) params.set('before', before)
  return `/api/workspaces/${props.workspaceId}/events?${params.toString()}`
}

async function loadPage(before?: string): Promise<void> {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    const response = await apiFetchResponse(historyUrl(before))
    if (!response.ok) throw await apiResponseError(response)
    const body = (await response.json()) as { events?: FetchedEvent[]; hasMore?: boolean }
    const byId = new Map(history.value.map((event) => [event.id, event]))
    for (const event of body.events ?? []) byId.set(event.id, event)
    history.value = [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    hasMore.value = body.hasMore === true
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

function loadInitial(): Promise<void> {
  history.value = []
  hasMore.value = false
  return loadPage()
}

function loadOlder(): Promise<void> {
  return loadPage(history.value[0]?.id)
}

function itemKey(item: Extract<ConversationItem, { type: 'text' | 'tool' }>): string {
  return item.type === 'text' ? `message:${item.messageId}` : `tool:${item.toolCallId}`
}

onMounted(() => void loadInitial())
</script>

<style scoped>
.subagent-activity { border-top: 1px solid var(--kobo-border-subtle); padding-top: 8px; }
.subagent-activity-list { display: grid; gap: 6px; max-height: 280px; overflow-y: auto; }
.subagent-activity-item { min-width: 0; }
</style>
