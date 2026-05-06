<template>
  <!-- Armed but not yet ready: grooming in progress (brainstorm creating tasks).
       Distinct styling so users don't confuse this with an active loop. -->
  <q-chip
    v-if="isOn && !isReady"
    dense
    square
    size="sm"
    color="indigo-4"
    text-color="white"
    icon="hourglass_top"
    class="q-ml-sm"
  >
    {{ t('autoLoop.preparing') }}
    <q-tooltip>{{ t('autoLoop.preparingTooltip') }}</q-tooltip>
  </q-chip>

  <!-- Ready + running: show task progress. -->
  <q-chip
    v-else-if="isOn"
    dense
    square
    size="sm"
    color="amber-9"
    text-color="white"
    icon="autorenew"
    class="q-ml-sm"
  >
    {{ t('autoLoop.progress', { done: tasksDone, total: tasksTotal }) }}
  </q-chip>
</template>

<script setup lang="ts">
import type { Workspace } from 'src/stores/workspace'
import { useWorkspaceStore } from 'src/stores/workspace'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

// Optional workspace prop — when omitted, falls back to the currently-selected
// workspace (legacy WorkspacePage usage). When provided, drives the chip from
// the cross-workspace `autoLoopStates` map (sidebar usage).
const props = withDefaults(defineProps<{ workspace?: Workspace | null }>(), { workspace: null })

const { t } = useI18n()
const store = useWorkspaceStore()

const ws = computed(() => props.workspace ?? store.selectedWorkspace)
const wsId = computed(() => ws.value?.id ?? null)
const status = computed(() => (wsId.value ? (store.autoLoopStates[wsId.value] ?? null) : null))
const isOn = computed(() => !!status.value?.auto_loop)
const isReady = computed(() => !!status.value?.auto_loop_ready)

// For the SELECTED workspace, `store.tasks` is the live source of truth and
// updates the moment a task is marked done. For other workspaces (sidebar
// cards), only the periodic /auto-loop-states snapshot is available.
const isSelected = computed(() => wsId.value !== null && store.selectedWorkspaceId === wsId.value)
const tasksDone = computed(() =>
  isSelected.value ? store.tasks.filter((t) => t.status === 'done').length : (status.value?.tasks_done ?? 0),
)
const tasksTotal = computed(() => (isSelected.value ? store.tasks.length : (status.value?.tasks_total ?? 0)))
</script>
