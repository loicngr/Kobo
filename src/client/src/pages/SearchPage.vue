<template>
  <q-page class="q-pa-md search-page">
    <div class="search-header">
      <h2 class="text-h5 q-mb-md">{{ $t('search.title') }}</h2>

      <q-input
        ref="inputEl"
        v-model="store.query"
        dense
        dark
        outlined
        clearable
        autofocus
        :placeholder="$t('search.placeholder')"
        @update:model-value="scheduleSearch"
        @clear="store.clear()"
      >
        <template #prepend>
          <q-icon name="search" />
        </template>
      </q-input>

      <div class="row items-center q-mt-sm q-gutter-sm">
        <q-toggle
          v-model="store.includeArchived"
          :label="$t('search.includeArchived')"
          dense
          dark
          color="indigo-4"
          size="sm"
        />
        <q-space />
        <span v-if="store.results.length > 0" class="text-caption text-grey-6">
          {{ $t('search.resultCount', { n: store.results.length }) }}
        </span>
      </div>
    </div>

    <q-separator dark class="q-my-md" />

    <div v-if="store.loading" class="text-grey-6 text-caption">{{ $t('search.loading') }}</div>

    <div v-else-if="store.error" class="text-negative text-caption">
      {{ $t('search.error', { message: store.error }) }}
    </div>

    <div
      v-else-if="store.query.trim().length > 0 && store.results.length === 0"
      class="text-grey-6 text-caption"
    >
      {{ $t('search.noResults') }}
    </div>

    <div v-else-if="store.results.length > 0" class="search-results">
      <div
        v-for="(r, idx) in store.results"
        :key="`${r.workspaceId}-${r.timestamp}-${idx}`"
        class="search-result q-pa-sm q-mb-sm cursor-pointer"
        @click="openResult(r.workspaceId)"
      >
        <div class="row items-center q-mb-xs text-caption">
          <span class="text-grey-5 text-weight-medium">{{ r.workspaceName }}</span>
          <q-badge v-if="r.archived" color="grey-7" class="q-ml-xs" :label="$t('common.archive')" />
          <q-space />
          <q-badge
            :color="r.type === 'user:message' ? 'blue-grey-7' : 'indigo-7'"
            class="q-mr-sm"
            :label="typeLabel(r.type)"
          />
          <span class="text-grey-6">{{ timeAgo(r.timestamp) }}</span>
        </div>
        <div class="search-snippet text-body2 text-grey-4">{{ r.snippet }}</div>
      </div>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { useSearchStore } from 'src/stores/search'
import { useTimeAgo } from 'src/utils/formatters'
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

const store = useSearchStore()
const router = useRouter()
const { t } = useI18n()
const { timeAgo } = useTimeAgo()

const inputEl = ref<HTMLInputElement | null>(null)
let debounceTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSearch(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    void store.search()
  }, 250)
}

// Re-run the search whenever the toggle flips, without waiting for debounce.
watch(
  () => store.includeArchived,
  () => {
    if (store.query.trim().length > 0) {
      void store.search()
    }
  },
)

function openResult(workspaceId: string): void {
  router.push({ name: 'workspace', params: { id: workspaceId } })
}

function typeLabel(type: string): string {
  if (type === 'user:message') return t('search.eventType.userMessage')
  if (type === 'agent:output') return t('search.eventType.agentOutput')
  return type
}
</script>

<style lang="scss" scoped>
.search-page {
  max-width: 900px;
  margin: 0 auto;
}
.search-result {
  background-color: #1e1e38;
  border: 1px solid #2a2a4a;
  border-radius: 6px;
  transition: border-color 120ms;

  &:hover {
    border-color: #6c63ff;
  }
}
.search-snippet {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.4;
}
</style>
