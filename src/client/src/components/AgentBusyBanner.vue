<script setup lang="ts">
import { useWorkspaceStore } from 'src/stores/workspace'
import { isBusyStatus } from 'src/utils/workspace-status'
import { computed, inject } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const store = useWorkspaceStore()
const openDrawerTab = inject<(tab: string) => void>('openDrawerTab')

const runningSubagentCount = computed(() => store.currentSubagents.filter((s) => s.status === 'running').length)

// Only show the banner when the workspace itself is busy. Orphaned sub-agents
// (status=running on a workspace that has already completed) shouldn't keep
// the banner up — they're a sign we missed a termination event, not that
// anything is actually running. The running count is still rendered inside
// the banner text when the banner IS visible (i.e. workspace busy + subs running).
const isVisible = computed(() => {
  const ws = store.selectedWorkspace
  if (!ws) return false
  return isBusyStatus(ws.status)
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
