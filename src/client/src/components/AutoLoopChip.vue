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
import { useWorkspaceStore } from 'src/stores/workspace'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const store = useWorkspaceStore()

const ws = computed(() => store.selectedWorkspace)
const status = computed(() => (ws.value ? (store.autoLoopStates[ws.value.id] ?? null) : null))
const isOn = computed(() => !!status.value?.auto_loop)
const isReady = computed(() => !!status.value?.auto_loop_ready)

const tasksDone = computed(() => store.tasks.filter((t) => t.status === 'done').length)
const tasksTotal = computed(() => store.tasks.length)
</script>
