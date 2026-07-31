<template>
  <div class="workspace-history-search q-px-md q-pt-sm">
    <q-input ref="searchInput" v-model="query" dense dark outlined debounce="250" :placeholder="$t('chat.searchWorkspaceHistory')" clearable>
      <template #prepend><q-icon name="search" size="18px" /></template>
      <template #append>
        <q-btn flat round dense size="sm" icon="close" color="grey-5" @click="close">
          <q-tooltip>{{ $t('common.close') }}</q-tooltip>
        </q-btn>
      </template>
    </q-input>
    <q-list v-if="results.length" dark class="history-results q-mt-sm rounded-borders">
      <q-item v-for="result in results" :key="result.eventId" clickable class="history-result" @click="open(result)">
        <q-item-section avatar top class="history-result-avatar">
          <q-icon :name="resultIcon(result.kind)" :color="resultColor(result.kind)" size="18px" />
        </q-item-section>
        <q-item-section>
          <q-item-label class="row items-center no-wrap">
            <span class="text-caption text-weight-medium" :class="`text-${resultColor(result.kind)}`">{{ resultLabel(result.kind) }}</span>
            <q-space />
            <span class="text-caption text-grey-7">{{ formatDate(result.createdAt) }}</span>
          </q-item-label>
          <q-item-label class="history-result-snippet">{{ result.snippet }}</q-item-label>
        </q-item-section>
      </q-item>
    </q-list>
  </div>
</template>

<script setup lang="ts">
import { useWorkspaceStore } from 'src/stores/workspace'
import { nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

interface SearchResult {
  eventId: string
  sessionId: string | null
  createdAt: string
  kind: 'user' | 'agent'
  snippet: string
}
const props = defineProps<{ workspaceId: string }>()
const emit = defineEmits<{ close: [] }>()
const store = useWorkspaceStore()
const { t } = useI18n()
const query = ref('')
const results = ref<SearchResult[]>([])
const searchInput = ref<{ focus: () => void } | null>(null)

watch(query, async (value) => {
  const search = value ?? ''
  if (search.trim().length < 2) {
    results.value = []
    return
  }
  const response = await fetch(`/api/workspaces/${props.workspaceId}/history-search?q=${encodeURIComponent(search)}`)
  if (!response.ok) return
  results.value = ((await response.json()) as { results: SearchResult[] }).results
})

async function open(result: SearchResult) {
  if (result.sessionId) await store.fetchSessions(props.workspaceId, result.sessionId)
  window.dispatchEvent(
    new CustomEvent('kobo:focus-history-event', {
      detail: { workspaceId: props.workspaceId, sessionId: result.sessionId, eventId: result.eventId },
    }),
  )
  close()
}

function close() {
  query.value = ''
  results.value = []
  emit('close')
}

function resultIcon(kind: SearchResult['kind']): string {
  return kind === 'user' ? 'person' : 'smart_toy'
}

function resultColor(kind: SearchResult['kind']): string {
  return kind === 'user' ? 'deep-purple-3' : 'indigo-3'
}

function resultLabel(kind: SearchResult['kind']): string {
  return t(`chat.historySearch.${kind}`)
}

function formatDate(createdAt: string): string {
  const date = new Date(createdAt)
  return Number.isNaN(date.getTime()) ? createdAt : date.toLocaleString()
}

onMounted(() => {
  void nextTick(() => searchInput.value?.focus())
})
</script>

<style scoped>
.history-results {
  border: 1px solid #303650;
  background: #171a2c;
  max-height: 360px;
  overflow-y: auto;
}
.history-result {
  min-height: 62px;
  padding: 9px 12px;
  border-left: 2px solid transparent;
}
.history-result + .history-result { border-top: 1px solid rgba(255, 255, 255, 0.06); }
.history-result:hover { background: rgba(129, 140, 248, 0.1); border-left-color: #818cf8; }
.history-result-avatar { min-width: 32px; padding-right: 4px; }
.history-result-snippet {
  color: #b9bfd0;
  font-size: 12px;
  line-height: 1.4;
  margin-top: 3px;
  white-space: normal;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
