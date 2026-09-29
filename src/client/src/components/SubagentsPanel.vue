<template>
  <div class="subagents-panel q-pa-md">
    <div class="row items-center no-wrap q-mb-sm">
      <div class="col text-caption text-uppercase text-weight-bold text-kobo-3" style="letter-spacing: 0.05em;">
        {{ $t('subagents.title') }}
      </div>
      <q-btn
        v-if="canStop && hasRunning"
        class="subagents-stop-all-btn"
        flat
        dense
        no-caps
        size="sm"
        color="negative"
        icon="stop"
        :label="t('subagents.stopAll')"
        :loading="stoppingAll"
        :disable="stoppingAll"
        @click="onStopAll"
      />
    </div>

    <div v-if="subagents.length === 0" class="text-caption text-kobo-3">
      {{ $t('subagents.empty') }}
    </div>

    <div v-for="sa in subagents" :key="cardId(sa)" class="subagent-item q-mb-sm rounded-borders q-pa-sm">
      <div class="row items-center q-mb-xs">
        <q-icon
          :name="STATUS_DISPLAY[sa.status].icon"
          size="14px"
          :color="STATUS_DISPLAY[sa.status].color"
          class="q-mr-xs"
        >
          <q-tooltip>{{ t(STATUS_DISPLAY[sa.status].label) }}</q-tooltip>
        </q-icon>
        <span class="col text-caption text-weight-medium text-kobo-1 ellipsis" style="max-width: 220px;">
          {{ sa.description || sa.toolUseId }}
        </span>
        <q-btn
          v-if="canStop && sa.status === 'running'"
          class="subagent-stop-btn"
          flat
          round
          dense
          size="xs"
          color="negative"
          icon="stop_circle"
          :disable="stoppingIds.has(cardId(sa))"
          @click="onStop(sa)"
        >
          <q-tooltip>{{ t('subagents.stop') }}</q-tooltip>
        </q-btn>
      </div>
      <div v-if="sa.ambient" class="row items-center text-caption text-kobo-3" style="font-size: 10px;">
        <q-icon name="visibility" size="12px" color="kobo-3" class="q-mr-xs" />
        {{ t('subagents.ambient') }}
        <q-tooltip>{{ t('subagents.ambientTooltip') }}</q-tooltip>
      </div>
      <div v-if="sa.lastToolName" class="text-caption text-kobo-3" style="font-size: 10px;">
        {{ $t('subagents.running') }}<span class="text-kobo-2">{{ sa.lastToolName }}</span>
      </div>
      <div class="row items-center q-gutter-xs q-mt-xs text-caption text-kobo-3" style="font-size: 10px;">
        <span v-if="sa.toolUses !== undefined">{{ $t('subagents.tools', { count: sa.toolUses }) }}</span>
        <span v-if="sa.totalTokens">· {{ formatTokens(sa.totalTokens) }} tok</span>
        <span v-if="sa.durationMs">· {{ formatDuration(sa.durationMs) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useQuasar } from 'quasar'
import { supportsSubagentStop } from 'src/constants/engineFeatures'
import { type Subagent, type SubagentStatus, useWorkspaceStore } from 'src/stores/workspace'
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const $q = useQuasar()
const store = useWorkspaceStore()

const subagents = computed(() => [...store.currentSubagents].reverse())

const canStop = computed(() => supportsSubagentStop(store.selectedWorkspace?.engine))
// Ambient watchers included: Stop all also stops them.
const hasRunning = computed(() => subagents.value.some((sa) => sa.status === 'running'))

/** Canonical card id, as the backend resolves it (task id, else tool call id). */
function cardId(sa: Subagent): string {
  return sa.taskId ?? sa.toolUseId
}

const stoppingIds = reactive(new Set<string>())
const stoppingAll = ref(false)

function notifyStopError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  $q.notify({
    type: 'negative',
    message: t('subagents.stopFailed', { error: message }),
    position: 'top',
    timeout: 4000,
  })
}

// No optimistic status change: the card turns `stopped` on its own
// `subagent:progress` event once the engine confirms the stop.
async function onStop(sa: Subagent): Promise<void> {
  const workspaceId = store.selectedWorkspaceId
  const id = cardId(sa)
  if (!workspaceId || stoppingIds.has(id)) return
  stoppingIds.add(id)
  try {
    await store.stopSubagents(workspaceId, id)
  } catch (err) {
    notifyStopError(err)
  } finally {
    stoppingIds.delete(id)
  }
}

async function onStopAll(): Promise<void> {
  const workspaceId = store.selectedWorkspaceId
  if (!workspaceId || stoppingAll.value) return
  stoppingAll.value = true
  try {
    await store.stopSubagents(workspaceId)
  } catch (err) {
    notifyStopError(err)
  } finally {
    stoppingAll.value = false
  }
}

const STATUS_DISPLAY: Record<SubagentStatus, { icon: string; color: string; label: string }> = {
  running: { icon: 'play_circle', color: 'green-4', label: 'subagents.status.running' },
  done: { icon: 'check_circle', color: 'kobo-3', label: 'subagents.status.done' },
  failed: { icon: 'error', color: 'negative', label: 'subagents.status.failed' },
  stopped: { icon: 'stop_circle', color: 'warning', label: 'subagents.status.stopped' },
}

function formatDuration(ms?: number): string {
  if (!ms) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const min = Math.floor(ms / 60_000)
  const sec = Math.floor((ms % 60_000) / 1000)
  return `${min}m ${sec}s`
}

function formatTokens(count?: number): string {
  if (!count) return ''
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
}
</script>

<style lang="scss" scoped>
.subagents-panel {
  overflow-y: auto;
}

.subagent-item {
  background: var(--kobo-surface);
  border: 1px solid var(--kobo-border-subtle);
}
</style>
