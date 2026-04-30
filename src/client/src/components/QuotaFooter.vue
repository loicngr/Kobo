<template>
  <span class="quota-footer">
    <template v-if="!snapshot">
      <span class="text-grey-7">{{ $t('quotaFooter.empty') }}</span>
    </template>

    <template v-else-if="snapshot.status === 'unauthenticated'">
      <q-icon name="warning" color="negative" size="14px" class="q-mr-xs" />
      <span class="text-negative text-weight-medium">{{ $t('quotaFooter.popover.unauthenticated') }}</span>
      <q-menu anchor="top right" self="bottom right" class="q-pa-md quota-menu">
        <div class="text-weight-medium q-mb-sm">{{ $t('quotaFooter.popover.title') }}</div>
        <div class="text-caption q-mb-sm">{{ $t('quotaFooter.popover.unauthenticatedHint') }}</div>
        <q-btn
          flat
          dense
          no-caps
          size="sm"
          icon="refresh"
          :label="$t('quotaFooter.popover.refreshNow')"
          :loading="refreshing"
          :disable="refreshing"
          @click="refresh"
        />
      </q-menu>
    </template>

    <template v-else-if="snapshot.status === 'error'">
      <q-icon name="error_outline" color="orange" size="14px" class="q-mr-xs" />
      <span class="text-orange text-weight-medium">{{ $t('quotaFooter.popover.error') }}</span>
      <q-menu anchor="top right" self="bottom right" class="q-pa-md quota-menu">
        <div class="text-weight-medium q-mb-sm">{{ $t('quotaFooter.popover.title') }}</div>
        <div class="text-caption text-orange q-mb-sm">{{ snapshot.errorMessage }}</div>
        <q-btn
          flat
          dense
          no-caps
          size="sm"
          icon="refresh"
          :label="$t('quotaFooter.popover.refreshNow')"
          :loading="refreshing"
          :disable="refreshing"
          @click="refresh"
        />
      </q-menu>
    </template>

    <template v-else>
      <span
        v-for="(bucket, idx) in snapshot.buckets"
        :key="bucket.id"
        class="quota-bucket-compact"
      >
        <span class="text-grey-8">{{ bucketLabelFor(bucket.label, idx) }}</span>
        <q-linear-progress
          :value="Math.max(0, Math.min(1, bucket.usedPct / 100))"
          :color="usagePctColor(bucket.usedPct)"
          track-color="grey-9"
          class="quota-bar"
        />
        <span :class="['bucket-pct', `text-${usagePctColor(bucket.usedPct)}`]">{{ bucket.usedPct.toFixed(0) }}%</span>
      </span>
      <q-menu anchor="top right" self="bottom right" class="q-pa-md quota-menu">
        <div class="text-weight-medium q-mb-sm">{{ $t('quotaFooter.popover.title') }}</div>
        <div
          v-for="(bucket, idx) in snapshot.buckets"
          :key="bucket.id"
          class="q-mb-sm"
        >
          <div class="row items-center justify-between q-mb-xs">
            <span>{{ bucketLabelFor(bucket.label, idx) }}</span>
            <span :class="`text-${usagePctColor(bucket.usedPct)}`">{{ bucket.usedPct.toFixed(0) }}%</span>
          </div>
          <q-linear-progress
            :value="Math.max(0, Math.min(1, bucket.usedPct / 100))"
            :color="usagePctColor(bucket.usedPct)"
            track-color="grey-9"
            class="full-bar"
          />
          <div v-if="bucket.resetsAt" class="text-caption q-mt-xs">
            {{ $t('quotaFooter.popover.resetsIn', { value: formatRateLimitResetAt(bucket.resetsAt) }) }}
          </div>
        </div>
        <div class="text-caption q-mt-sm">{{ $t('quotaFooter.lastUpdated', { time: formattedUpdatedAt }) }}</div>
        <div class="row q-gutter-sm q-mt-sm">
          <q-btn
            flat
            dense
            no-caps
            size="sm"
            icon="refresh"
            :label="$t('quotaFooter.popover.refreshNow')"
            :loading="refreshing"
            :disable="refreshing"
            @click="refresh"
          />
          <q-btn
            flat
            dense
            no-caps
            size="sm"
            icon="bar_chart"
            :label="$t('quotaFooter.popover.openStatsPanel')"
            @click="openStatsPanel"
          />
        </div>
      </q-menu>
    </template>
  </span>
</template>

<script setup lang="ts">
import { useStatsStore } from 'src/stores/stats'
import { useWorkspaceStore } from 'src/stores/workspace'
import { formatRateLimitBucketLabel, formatRateLimitResetAt, usagePctColor } from 'src/utils/rate-limit-labels'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const store = useWorkspaceStore()
const statsStore = useStatsStore()
const { t } = useI18n()

const snapshot = computed(() => store.currentProviderUsage)
const refreshing = ref(false)

const formattedUpdatedAt = computed(() => {
  const snap = snapshot.value
  if (!snap) return ''
  try {
    return new Date(snap.fetchedAt).toLocaleTimeString()
  } catch {
    return snap.fetchedAt
  }
})

function bucketLabelFor(rawLabel: string | undefined, idx: number): string {
  const snap = snapshot.value
  const bucket = snap?.buckets[idx]
  if (!bucket) return t('stats.usageBucket', { n: idx + 1 })
  return formatRateLimitBucketLabel(
    { id: bucket.id, label: rawLabel, usedPct: bucket.usedPct, resetAt: bucket.resetsAt },
    idx,
    t,
  )
}

async function refresh(): Promise<void> {
  if (refreshing.value) return
  refreshing.value = true
  try {
    await store.requestUsageRefresh('claude-code')
  } finally {
    refreshing.value = false
  }
}

function openStatsPanel(): void {
  statsStore.requestOpenStats()
}
</script>

<style lang="scss" scoped>
.quota-footer {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  white-space: nowrap;
  cursor: pointer;
}

.quota-bucket-compact {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}

.bucket-pct {
  font-variant-numeric: tabular-nums;
}

.quota-bar {
  width: 32px;
  height: 5px;
  border-radius: 3px;
}

.full-bar {
  height: 6px;
  border-radius: 3px;
}

.quota-menu {
  min-width: 240px;
}
</style>
