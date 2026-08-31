<template>
  <q-page class="q-pa-md search-page">
    <div class="search-header">
      <div class="row items-center">
        <DrawerToggleButton class="q-mr-sm" />
        <h2 class="text-h5 q-mb-md">{{ $t('search.title') }}</h2>
      </div>

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
          color="primary"
          size="sm"
        />
        <q-space />
        <span v-if="store.results.length > 0" class="text-caption text-kobo-3">
          {{ $t('search.resultCount', { n: store.results.length }) }}
        </span>
      </div>
    </div>

    <q-separator dark class="q-my-md" />

    <div v-if="store.loading" class="text-kobo-3 text-caption">{{ $t('search.loading') }}</div>

    <div v-else-if="store.error" class="text-negative text-caption">
      {{ $t('search.error', { message: store.error }) }}
    </div>

    <div
      v-else-if="store.query.trim().length > 0 && store.results.length === 0"
      class="text-kobo-3 text-caption"
    >
      {{ $t('search.noResults') }}
    </div>

    <div v-else-if="store.results.length > 0" class="search-results">
      <div
        v-for="(r, idx) in store.results"
        :key="`${r.workspaceId}-${r.timestamp}-${idx}`"
        class="search-result q-pa-sm q-mb-sm cursor-pointer"
        @click="openResult(r)"
      >
        <div class="row items-center q-mb-xs text-caption">
          <span class="text-kobo-2 text-weight-medium">{{ r.workspaceName }}</span>
          <q-badge v-if="r.archived" color="kobo-3" class="q-ml-xs" :label="$t('common.archive')" />
          <q-space />
          <q-badge
            :color="r.type === 'user:message' ? 'blue-grey-7' : 'primary'"
            class="q-mr-sm"
            :label="typeLabel(r.type)"
          />
          <span class="text-kobo-3">{{ timeAgo(r.timestamp) }}</span>
        </div>
        <div class="search-snippet text-body2 text-kobo-2">{{ r.snippet }}</div>
      </div>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import DrawerToggleButton from 'src/components/DrawerToggleButton.vue'
import { type SearchResult, useSearchStore } from 'src/stores/search'
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

function openResult(result: SearchResult): void {
  router.push({
    name: 'workspace',
    params: { id: result.workspaceId },
    query: {
      eventId: result.eventId,
      ...(result.sessionId ? { session: result.sessionId } : {}),
    },
  })
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
  background-color: var(--kobo-surface-2);
  border: 1px solid var(--kobo-border-subtle);
  border-radius: 6px;
  transition: border-color 120ms;

  &:hover {
    border-color: var(--kobo-accent);
  }
}
.search-snippet {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.4;
}
</style>
