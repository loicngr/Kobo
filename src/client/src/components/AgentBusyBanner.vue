<script setup lang="ts">
import { useWorkspaceStore } from 'src/stores/workspace'
import { isBusyStatus } from 'src/utils/workspace-status'
import { computed, inject } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const store = useWorkspaceStore()
const openDrawerTab = inject<(tab: string) => void>('openDrawerTab')

const runningSubagentCount = computed(() => store.currentSubagents.filter((s) => s.status === 'running').length)

const isVisible = computed(() => {
  const ws = store.selectedWorkspace
  if (!ws) return false
  return isBusyStatus(ws.status) || runningSubagentCount.value > 0
})

function viewSubagents() {
  openDrawerTab?.('subagents')
}
</script>

<template>
  <div v-if="isVisible" class="row items-center q-pa-xs q-px-sm bg-dark text-grey-5 text-caption">
    <q-spinner-dots size="14px" color="indigo-4" class="q-mr-sm" />
    <span>{{ t('agentBusy.banner') }}</span>
    <span v-if="runningSubagentCount > 0" class="q-ml-xs">
      — {{ t('agentBusy.subagentsRunning', { n: runningSubagentCount }, runningSubagentCount) }}
    </span>
    <template v-if="runningSubagentCount > 0">
      <q-space />
      <span
        class="text-indigo-4 cursor-pointer"
        style="text-decoration: underline;"
        @click="viewSubagents"
      >
        {{ t('agentBusy.viewSubagents') }}
      </span>
    </template>
  </div>
</template>
