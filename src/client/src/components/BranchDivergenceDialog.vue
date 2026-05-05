<template>
  <q-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)">
    <q-card style="min-width: 600px; max-width: 90vw;" dark>
      <q-card-section class="q-pb-none">
        <div class="text-h6">{{ $t('git.divergence.title') }}</div>
        <div class="text-body2 text-grey-5 q-mt-xs">
          {{ $t('git.divergence.subtitle', { source: sourceBranch }) }}
        </div>
      </q-card-section>

      <q-tabs v-model="activeTab" dense align="left" inline-label class="q-mt-sm" indicator-color="indigo-4">
        <q-tab name="ahead" :label="$t('git.divergence.ahead', { count: aheadCount })" />
        <q-tab name="behind" :label="$t('git.divergence.behind', { count: behindCount })" />
      </q-tabs>
      <q-separator dark />

      <q-tab-panels v-model="activeTab" animated style="max-height: 60vh;">
        <q-tab-panel name="ahead" class="q-pa-md">
          <div v-if="loading" class="text-caption text-grey-6 row items-center">
            <q-spinner size="xs" class="q-mr-xs" />{{ $t('git.divergence.loading') }}
          </div>
          <div v-else-if="error" class="row items-center q-gutter-sm">
            <span class="text-caption text-negative">{{ error }}</span>
            <q-btn flat dense no-caps :label="$t('git.divergence.retry')" color="indigo-4" @click="reload" />
          </div>
          <div v-else-if="ahead.length === 0" class="text-caption text-grey-6">
            {{ $t('git.divergence.empty.ahead') }}
          </div>
          <div v-else>
            <div
              v-for="commit in ahead"
              :key="commit.sha"
              class="commit-item row no-wrap items-center cursor-pointer q-py-xs"
              @click="onCommitClick(commit.sha)"
            >
              <q-icon
                :name="commit.isPushed ? 'cloud_done' : 'cloud_upload'"
                size="12px"
                :color="commit.isPushed ? 'grey-6' : 'orange-5'"
                class="q-mr-xs"
              />
              <span class="commit-sha text-grey-5">{{ commit.shortSha }}</span>
              <span class="commit-subject text-grey-4 ellipsis q-ml-sm">{{ commit.subject }}</span>
              <q-tooltip anchor="top middle" self="bottom middle">
                <div class="text-caption">
                  <div><code>{{ commit.sha }}</code></div>
                  <div class="text-grey-5 q-mt-xs">{{ commit.author }} · {{ formatDate(commit.date) }}</div>
                </div>
              </q-tooltip>
            </div>
          </div>
        </q-tab-panel>

        <q-tab-panel name="behind" class="q-pa-md">
          <div v-if="loading" class="text-caption text-grey-6 row items-center">
            <q-spinner size="xs" class="q-mr-xs" />{{ $t('git.divergence.loading') }}
          </div>
          <div v-else-if="error" class="row items-center q-gutter-sm">
            <span class="text-caption text-negative">{{ error }}</span>
            <q-btn flat dense no-caps :label="$t('git.divergence.retry')" color="indigo-4" @click="reload" />
          </div>
          <div v-else-if="behind.length === 0" class="text-caption text-grey-6">
            {{ $t('git.divergence.empty.behind') }}
          </div>
          <div v-else>
            <div
              v-for="commit in behind"
              :key="commit.sha"
              class="commit-item row no-wrap items-center cursor-pointer q-py-xs"
              @click="onCommitClick(commit.sha)"
            >
              <span class="commit-sha text-grey-5">{{ commit.shortSha }}</span>
              <span class="commit-subject text-grey-4 ellipsis q-ml-sm">{{ commit.subject }}</span>
              <q-tooltip anchor="top middle" self="bottom middle">
                <div class="text-caption">
                  <div><code>{{ commit.sha }}</code></div>
                  <div class="text-grey-5 q-mt-xs">{{ commit.author }} · {{ formatDate(commit.date) }}</div>
                </div>
              </q-tooltip>
            </div>
          </div>
        </q-tab-panel>
      </q-tab-panels>

      <q-card-actions align="right" class="q-pa-md">
        <q-btn flat no-caps :label="$t('git.divergence.close')" color="grey-5" @click="close" />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import type { BranchCommit, Commit } from 'src/stores/workspace'
import { useWorkspaceStore } from 'src/stores/workspace'
import { onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  modelValue: boolean
  workspaceId: string
  initialTab: 'ahead' | 'behind'
  aheadCount: number
  behindCount: number
  sourceBranch: string
  workingBranch: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'append-sha', sha: string): void
}>()

const { t } = useI18n()
const store = useWorkspaceStore()

const activeTab = ref<'ahead' | 'behind'>(props.initialTab)
const ahead = ref<BranchCommit[]>([])
const behind = ref<Commit[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

let inflightController: AbortController | null = null

async function load() {
  inflightController?.abort()
  const controller = new AbortController()
  inflightController = controller
  loading.value = true
  error.value = null
  try {
    const data = await store.fetchBranchDivergence(props.workspaceId, { signal: controller.signal })
    if (controller.signal.aborted) return
    ahead.value = data.ahead
    behind.value = data.behind
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return
    error.value = t('git.divergence.failed')
  } finally {
    if (inflightController === controller) inflightController = null
    loading.value = false
  }
}

function reload() {
  load()
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      activeTab.value = props.initialTab
      load()
    } else {
      inflightController?.abort()
      ahead.value = []
      behind.value = []
      error.value = null
    }
  },
)

function onCommitClick(sha: string) {
  emit('append-sha', sha)
}

function close() {
  emit('update:modelValue', false)
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString()
  } catch {
    return iso
  }
}

onBeforeUnmount(() => {
  inflightController?.abort()
})
</script>

<style lang="scss" scoped>
.commit-item:hover {
  background: rgba(255, 255, 255, 0.04);
}
.commit-sha {
  font-family: 'Roboto Mono', monospace;
  font-size: 11px;
}
.commit-subject {
  font-size: 12px;
  max-width: 480px;
}
</style>
