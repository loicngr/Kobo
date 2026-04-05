<script setup lang="ts">
import { useWorkspaceStore } from 'src/stores/workspace'
import { computed } from 'vue'

const store = useWorkspaceStore()

const subagents = computed(() => store.currentSubagents)

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

<template>
  <div class="subagents-panel q-pa-md">
    <div class="text-caption text-uppercase text-weight-bold text-grey-6 q-mb-sm" style="letter-spacing: 0.05em;">
      Sub-agents
    </div>

    <div v-if="subagents.length === 0" class="text-caption text-grey-8">
      No sub-agent activity yet
    </div>

    <div v-for="sa in subagents" :key="sa.toolUseId" class="subagent-item q-mb-sm rounded-borders q-pa-sm">
      <div class="row items-center q-mb-xs">
        <q-icon
          :name="sa.status === 'running' ? 'play_circle' : 'check_circle'"
          size="14px"
          :color="sa.status === 'running' ? 'green-4' : 'grey-6'"
          class="q-mr-xs"
        />
        <span class="text-caption text-weight-medium text-grey-3 ellipsis" style="max-width: 220px;">
          {{ sa.description || sa.toolUseId }}
        </span>
      </div>
      <div v-if="sa.lastToolName" class="text-caption text-grey-6" style="font-size: 10px;">
        Running: <span class="text-grey-4">{{ sa.lastToolName }}</span>
      </div>
      <div class="row items-center q-gutter-xs q-mt-xs text-caption text-grey-7" style="font-size: 10px;">
        <span v-if="sa.toolUses !== undefined">{{ sa.toolUses }} tools</span>
        <span v-if="sa.totalTokens">· {{ formatTokens(sa.totalTokens) }} tok</span>
        <span v-if="sa.durationMs">· {{ formatDuration(sa.durationMs) }}</span>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.subagents-panel {
  overflow-y: auto;
}

.subagent-item {
  background: #1e1e3a;
  border: 1px solid #2a2a4a;
}
</style>
