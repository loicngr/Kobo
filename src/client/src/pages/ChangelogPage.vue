<template>
  <q-page class="q-pa-md" style="max-width: 900px; margin: 0 auto;">
    <div class="row items-center q-mb-md">
      <q-btn flat dense round icon="arrow_back" @click="router.back()" />
      <div class="text-h6 q-ml-sm">{{ $t('changelog.title') }}</div>
      <q-space />
      <q-btn flat dense icon="refresh" :loading="loading" :label="$t('common.refresh')" @click="load" />
    </div>

    <div v-if="loading && versions.length === 0" class="text-grey-6 text-center q-pa-lg">
      {{ $t('common.loading') }}
    </div>

    <div v-else-if="error" class="text-negative text-center q-pa-lg">
      {{ error }}
    </div>

    <div v-else-if="versions.length === 0" class="text-grey-6 text-center q-pa-lg">
      {{ $t('changelog.empty') }}
    </div>

    <div v-else class="column q-gutter-md">
      <div v-if="currentVersion" class="text-caption text-grey-6">
        {{ $t('changelog.currentVersion', { version: currentVersion }) }}
      </div>

      <q-card v-for="entry in versions" :key="entry.version" dark flat bordered>
        <q-card-section>
          <div class="row items-center q-mb-sm">
            <div class="text-subtitle1 text-indigo-3" style="font-family: var(--kobo-font-mono, monospace);">
              v{{ entry.version }}
            </div>
            <q-chip
              v-if="entry.version === currentVersion"
              dense
              size="sm"
              color="indigo-7"
              text-color="grey-2"
              :label="$t('changelog.current')"
              class="q-ml-sm"
            />
          </div>
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div class="changelog-notes" v-html="renderNotes(entry.notes)" />
        </q-card-section>
      </q-card>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { renderChatMarkdown } from 'src/utils/render-chat-markdown'
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

interface ChangelogEntry {
  version: string
  notes: string
}

const router = useRouter()
const versions = ref<ChangelogEntry[]>([])
const currentVersion = ref<string>('')
const loading = ref<boolean>(false)
const error = ref<string | null>(null)

function renderNotes(notes: string): string {
  return renderChatMarkdown(notes)
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const res = await fetch('/api/changelog')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as { currentVersion?: string; versions?: ChangelogEntry[] }
    currentVersion.value = body.currentVersion ?? ''
    versions.value = body.versions ?? []
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.changelog-notes {
  color: #cfcfe0;
  font-size: 13px;
  line-height: 1.55;
}
.changelog-notes :deep(h3) {
  font-size: 14px;
  font-weight: 600;
  color: #d8d8e8;
  margin: 0.8em 0 0.3em;
}
.changelog-notes :deep(ul) {
  margin: 0;
  padding-left: 1.2em;
}
.changelog-notes :deep(li) {
  margin: 0.2em 0;
}
.changelog-notes :deep(code) {
  background: rgba(0, 0, 0, 0.25);
  padding: 0.1em 0.3em;
  border-radius: 3px;
  font-size: 12px;
}
.changelog-notes :deep(a) {
  color: #8a93ff;
}
</style>
