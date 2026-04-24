<script setup lang="ts">
import type { Workspace } from 'src/stores/workspace'
import { useWorkspaceStore } from 'src/stores/workspace'
import { useTimeAgo } from 'src/utils/formatters'
import { formatRateLimitBucketLabel, formatRateLimitResetAt } from 'src/utils/rate-limit-labels'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

defineProps<{
  workspace: Workspace | null
}>()

const { t } = useI18n()
const store = useWorkspaceStore()
const { timeAgo } = useTimeAgo()

const stats = computed(() => {
  const wid = store.selectedWorkspaceId
  if (!wid) return null

  const feed = store.activityFeeds[wid] ?? []
  const sessions = store.sessions
  const subagents = Object.values(store.subagents[wid] ?? {})
  const tasks = store.tasks
  const ws = store.selectedWorkspace

  // Activity counts — read from pre-computed counters (incremented in addActivityItem)
  const counts = store.activityCounts[wid] ?? { toolUses: 0, agentMessages: 0, userMessages: 0, errors: 0 }
  const toolUses = counts.toolUses
  const agentMessages = counts.agentMessages
  const userMessages = counts.userMessages
  const errors = counts.errors

  // Sessions
  const totalSessions = sessions.length
  const completedSessions = sessions.filter((s) => s.status === 'completed').length

  // Subagents
  const totalSubagents = subagents.length
  const doneSubagents = subagents.filter((s) => s.status === 'done').length
  const totalSubagentTokens = subagents.reduce((sum, s) => sum + (s.totalTokens ?? 0), 0)
  const totalSubagentTools = subagents.reduce((sum, s) => sum + (s.toolUses ?? 0), 0)

  // Tasks
  const totalTasks = tasks.filter((t) => !t.isAcceptanceCriterion).length
  const doneTasks = tasks.filter((t) => !t.isAcceptanceCriterion && t.status === 'done').length
  const totalCriteria = tasks.filter((t) => t.isAcceptanceCriterion).length
  const doneCriteria = tasks.filter((t) => t.isAcceptanceCriterion && t.status === 'done').length

  // Timestamps
  const createdAt = ws?.createdAt ? new Date(ws.createdAt) : null
  const updatedAt = ws?.updatedAt ? new Date(ws.updatedAt) : null
  const durationMs = createdAt ? Date.now() - createdAt.getTime() : 0

  // Last user / agent message timestamps — scan backward without copying the array
  let lastPromptAt: Date | null = null
  let lastAgentResponseAt: Date | null = null
  for (let i = feed.length - 1; i >= 0; i--) {
    const item = feed[i]
    if (!lastPromptAt && item.meta?.sender === 'user') {
      lastPromptAt = new Date(item.timestamp)
    }
    if (
      !lastAgentResponseAt &&
      item.type === 'text' &&
      item.meta?.sender !== 'user' &&
      item.meta?.sender !== 'system-prompt'
    ) {
      lastAgentResponseAt = new Date(item.timestamp)
    }
    if (lastPromptAt && lastAgentResponseAt) break
  }

  // First session start
  const firstSessionAt = sessions.length > 0 ? new Date(sessions[sessions.length - 1].startedAt) : null

  // Usage (tokens / cost)
  const usage = store.usageStats[wid] ?? { inputTokens: 0, outputTokens: 0, costUsd: 0, sessionCount: 0 }
  const rateLimitUsage = store.rateLimitUsage[wid]

  // Model & branch
  const model = ws?.model ?? 'auto'
  const branch = ws?.workingBranch ?? ''
  const status = ws?.status ?? ''

  return {
    toolUses,
    agentMessages,
    userMessages,
    errors,
    totalSessions,
    completedSessions,
    totalSubagents,
    doneSubagents,
    totalSubagentTokens,
    totalSubagentTools,
    totalTasks,
    doneTasks,
    totalCriteria,
    doneCriteria,
    durationMs,
    createdAt,
    updatedAt,
    lastPromptAt,
    lastAgentResponseAt,
    firstSessionAt,
    model,
    branch,
    status,
    usage,
    rateLimitUsage,
  }
})

function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60000)
  if (totalMin < 60) return `${totalMin}m`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h < 24) return `${h}h ${m}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatDate(d: Date): string {
  return d.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function formatDateTime(d: Date): string {
  return `${formatDate(d)} ${formatTime(d)}`
}

function formatUsageBucketLabel(label: string | undefined, idx: number): string {
  const bucket = stats.value?.rateLimitUsage?.buckets[idx]
  if (!bucket) return t('stats.usageBucket', { n: idx + 1 })
  return formatRateLimitBucketLabel({ id: bucket.id, label, usedPct: bucket.usedPct, resetAt: bucket.resetAt }, idx, t)
}

function toPercent(value: number, total: number): number {
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, (value / total) * 100))
}
</script>

<template>
  <div class="stats-panel q-pa-md">
    <div class="row items-center q-mb-md">
      <div class="text-caption text-uppercase text-weight-bold text-grey-6" style="letter-spacing: 0.05em;">
        {{ $t('stats.title') }}
      </div>
      <q-space />
      <q-btn
        v-if="workspace"
        flat
        round
        dense
        size="xs"
        icon="refresh"
        color="grey-6"
        @click="store.fetchWorkspaceDetails(workspace.id)"
      >
        <q-tooltip>{{ $t('tooltip.refreshStats') }}</q-tooltip>
      </q-btn>
    </div>

    <template v-if="workspace && stats">
      <!-- Info -->
      <div class="stat-group-label q-mb-xs">{{ $t('stats.info') }}</div>
      <div class="stat-row">
        <span class="stat-label">{{ $t('stats.status') }}</span>
        <span class="stat-value">{{ stats.status }}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">{{ $t('stats.model') }}</span>
        <span class="stat-value">{{ stats.model }}</span>
      </div>
      <div v-if="stats.branch" class="stat-row">
        <span class="stat-label">{{ $t('stats.branch') }}</span>
        <span class="stat-value stat-value-ellipsis">{{ stats.branch }}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">{{ $t('stats.sessions') }}</span>
        <span class="stat-value">{{ stats.completedSessions }} / {{ stats.totalSessions }}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">{{ $t('stats.duration') }}</span>
        <span class="stat-value">{{ formatDuration(stats.durationMs) }}</span>
      </div>

      <q-separator dark class="q-my-sm" />

      <!-- Dates -->
      <div class="stat-group-label q-mb-xs">{{ $t('stats.timeline') }}</div>
      <div class="stat-row">
        <span class="stat-label">{{ $t('stats.created') }}</span>
        <span class="stat-value">{{ stats.createdAt ? formatDateTime(stats.createdAt) : '—' }}</span>
      </div>
      <div v-if="stats.firstSessionAt" class="stat-row">
        <span class="stat-label">{{ $t('stats.firstSession') }}</span>
        <span class="stat-value">{{ formatDateTime(stats.firstSessionAt) }}</span>
      </div>
      <div v-if="stats.lastPromptAt" class="stat-row">
        <span class="stat-label">{{ $t('stats.lastPrompt') }}</span>
        <span class="stat-value">
          {{ timeAgo(stats.lastPromptAt) }}
          <q-tooltip>{{ formatDateTime(stats.lastPromptAt) }}</q-tooltip>
        </span>
      </div>
      <div v-if="stats.lastAgentResponseAt" class="stat-row">
        <span class="stat-label">{{ $t('stats.lastResponse') }}</span>
        <span class="stat-value">
          {{ timeAgo(stats.lastAgentResponseAt) }}
          <q-tooltip>{{ formatDateTime(stats.lastAgentResponseAt) }}</q-tooltip>
        </span>
      </div>
      <div v-if="stats.updatedAt" class="stat-row">
        <span class="stat-label">{{ $t('stats.updated') }}</span>
        <span class="stat-value">{{ timeAgo(stats.updatedAt) }}</span>
      </div>

      <q-separator dark class="q-my-sm" />

      <!-- Activity -->
      <div class="stat-group-label q-mb-xs">{{ $t('stats.activity') }}</div>
      <div class="stat-row">
        <span class="stat-label">{{ $t('stats.agentMessages') }}</span>
        <span class="stat-value">{{ stats.agentMessages }}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">{{ $t('stats.userMessages') }}</span>
        <span class="stat-value">{{ stats.userMessages }}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">{{ $t('stats.toolCalls') }}</span>
        <span class="stat-value">{{ stats.toolUses }}</span>
      </div>
      <div v-if="stats.errors > 0" class="stat-row">
        <span class="stat-label text-red-4">{{ $t('stats.errors') }}</span>
        <span class="stat-value text-red-4">{{ stats.errors }}</span>
      </div>

      <!-- Usage (tokens / cost) -->
      <div v-if="stats.usage.inputTokens > 0 || stats.usage.outputTokens > 0">
        <q-separator dark class="q-my-sm" />
        <div class="stat-group-label q-mb-xs">{{ $t('stats.usage') }}</div>
        <div class="usage-breakdown q-mb-sm">
          <div
            class="usage-breakdown-input"
            :style="{ width: `${toPercent(stats.usage.inputTokens, stats.usage.inputTokens + stats.usage.outputTokens)}%` }"
          />
          <div
            class="usage-breakdown-output"
            :style="{ width: `${toPercent(stats.usage.outputTokens, stats.usage.inputTokens + stats.usage.outputTokens)}%` }"
          />
        </div>
        <div class="stat-row">
          <span class="stat-label">{{ $t('stats.inputTokens') }}</span>
          <span class="stat-value">
            {{ formatTokens(stats.usage.inputTokens) }}
            <span class="stat-value-muted">
              ({{ toPercent(stats.usage.inputTokens, stats.usage.inputTokens + stats.usage.outputTokens).toFixed(0) }}%)
            </span>
          </span>
        </div>
        <div class="stat-row">
          <span class="stat-label">{{ $t('stats.outputTokens') }}</span>
          <span class="stat-value">
            {{ formatTokens(stats.usage.outputTokens) }}
            <span class="stat-value-muted">
              ({{ toPercent(stats.usage.outputTokens, stats.usage.inputTokens + stats.usage.outputTokens).toFixed(0) }}%)
            </span>
          </span>
        </div>
        <div class="stat-row">
          <span class="stat-label">{{ $t('stats.totalTokens') }}</span>
          <span class="stat-value">{{ formatTokens(stats.usage.inputTokens + stats.usage.outputTokens) }}</span>
        </div>
        <div v-if="stats.usage.costUsd > 0" class="stat-row">
          <span class="stat-label">{{ $t('stats.cost') }}</span>
          <span class="stat-value">${{ stats.usage.costUsd.toFixed(4) }}</span>
        </div>
      </div>

      <div v-if="stats.rateLimitUsage?.buckets?.length">
        <q-separator dark class="q-my-sm" />
        <div class="stat-group-label q-mb-xs">{{ $t('stats.usageLimits') }}</div>
        <div
          v-for="(bucket, idx) in stats.rateLimitUsage.buckets"
          :key="bucket.id"
          class="q-mb-sm"
        >
          <div class="stat-row q-mb-xxs">
            <span class="stat-label">{{ formatUsageBucketLabel(bucket.label, idx) }}</span>
            <span class="stat-value">{{ bucket.usedPct.toFixed(0) }}% {{ $t('stats.used') }}</span>
          </div>
          <q-linear-progress
            :value="bucket.usedPct / 100"
            color="indigo-4"
            track-color="grey-9"
            style="height: 6px; border-radius: 999px;"
          />
          <div v-if="bucket.details || bucket.resetAt" class="stat-subtext q-mt-xxs">
            <span v-if="bucket.details">{{ bucket.details }}</span>
            <span v-if="bucket.details && bucket.resetAt"> · </span>
            <span v-if="bucket.resetAt">{{ $t('stats.resetsAt', { value: formatRateLimitResetAt(bucket.resetAt) }) }}</span>
          </div>
        </div>
      </div>

      <!-- Subagents -->
      <div v-if="stats.totalSubagents > 0">
        <q-separator dark class="q-my-sm" />
        <div class="stat-group-label q-mb-xs">{{ $t('stats.subagents') }}</div>
        <div class="stat-row">
          <span class="stat-label">{{ $t('stats.completed') }}</span>
          <span class="stat-value">{{ stats.doneSubagents }} / {{ stats.totalSubagents }}</span>
        </div>
        <div v-if="stats.totalSubagentTokens > 0" class="stat-row">
          <span class="stat-label">{{ $t('stats.tokens') }}</span>
          <span class="stat-value">{{ formatTokens(stats.totalSubagentTokens) }}</span>
        </div>
        <div v-if="stats.totalSubagentTools > 0" class="stat-row">
          <span class="stat-label">{{ $t('stats.toolCalls') }}</span>
          <span class="stat-value">{{ stats.totalSubagentTools }}</span>
        </div>
      </div>

      <!-- Tasks progress -->
      <div v-if="stats.totalTasks > 0 || stats.totalCriteria > 0">
        <q-separator dark class="q-my-sm" />
        <div class="stat-group-label q-mb-xs">{{ $t('stats.progress') }}</div>
        <div v-if="stats.totalTasks > 0" class="q-mb-xs">
          <div class="stat-row q-mb-xxs">
            <span class="stat-label">{{ $t('stats.tasks') }}</span>
            <span class="stat-value">{{ stats.doneTasks }} / {{ stats.totalTasks }}</span>
          </div>
          <q-linear-progress
            :value="stats.doneTasks / stats.totalTasks"
            color="primary"
            track-color="grey-9"
            style="height: 3px; border-radius: 2px;"
          />
        </div>
        <div v-if="stats.totalCriteria > 0">
          <div class="stat-row q-mb-xxs">
            <span class="stat-label">{{ $t('stats.acceptanceCriteria') }}</span>
            <span class="stat-value">{{ stats.doneCriteria }} / {{ stats.totalCriteria }}</span>
          </div>
          <q-linear-progress
            :value="stats.doneCriteria / stats.totalCriteria"
            color="green-6"
            track-color="grey-9"
            style="height: 3px; border-radius: 2px;"
          />
        </div>
      </div>
    </template>

    <div v-else class="text-caption text-grey-8">
      {{ $t('common.selectWorkspace') }}
    </div>
  </div>
</template>

<style lang="scss" scoped>
.stat-group-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #888;
  font-weight: 600;
}

.stat-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 2px 0;
}

.stat-label {
  font-size: 12px;
  color: #999;
}

.stat-value {
  font-size: 12px;
  color: #ddd;
  font-weight: 500;
  font-family: 'Roboto Mono', monospace;
}

.stat-value-muted {
  color: #999;
  font-size: 11px;
  margin-left: 4px;
}

.stat-subtext {
  color: #8a8aa8;
  font-size: 11px;
}

.usage-breakdown {
  display: flex;
  width: 100%;
  height: 8px;
  border-radius: 999px;
  overflow: hidden;
  background: #2a2a4f;
  border: 1px solid #3b3b61;
}

.usage-breakdown-input {
  height: 100%;
  background: linear-gradient(90deg, #6d76ff 0%, #8f96ff 100%);
}

.usage-breakdown-output {
  height: 100%;
  background: linear-gradient(90deg, #7f6bff 0%, #a598ff 100%);
}

.stat-value-ellipsis {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stat-section {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
</style>
