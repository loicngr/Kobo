<script setup lang="ts">
import { useWorkspaceStore } from 'src/stores/workspace'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const store = useWorkspaceStore()
const { t } = useI18n()

const snapshot = computed(() => store.globalRateLimitUsage)

function bucketLabel(label: string | undefined, idx: number): string {
  return label && label.trim().length > 0 ? label : t('stats.usageBucket', { n: idx + 1 })
}

const summary = computed(() => {
  const snap = snapshot.value
  if (!snap || snap.buckets.length === 0) {
    return `${t('quotaFooter.placeholder')} 0%`
  }
  return snap.buckets.map((b, idx) => `${bucketLabel(b.label, idx)} ${b.usedPct.toFixed(0)}%`).join(' · ')
})

const formattedUpdatedAt = computed(() => {
  const snap = snapshot.value
  if (!snap) return ''
  try {
    return new Date(snap.updatedAt).toLocaleTimeString()
  } catch {
    return snap.updatedAt
  }
})
</script>

<template>
  <span class="quota-footer" :class="{ 'quota-footer--empty': !snapshot }">
    {{ summary }}
    <q-tooltip v-if="snapshot">
      <div class="text-weight-medium">{{ $t('quotaFooter.tooltipTitle') }}</div>
      <div
        v-for="(bucket, idx) in snapshot.buckets"
        :key="bucket.id"
        class="q-mt-xs"
      >
        <div>{{ bucketLabel(bucket.label, idx) }} — {{ bucket.usedPct.toFixed(0) }}% {{ $t('stats.used') }}</div>
        <div v-if="bucket.details" class="text-caption">{{ bucket.details }}</div>
        <div v-if="bucket.resetAt" class="text-caption">{{ $t('stats.resetsAt', { value: bucket.resetAt }) }}</div>
      </div>
      <div class="text-caption q-mt-sm">{{ $t('quotaFooter.lastUpdated', { time: formattedUpdatedAt }) }}</div>
    </q-tooltip>
    <q-tooltip v-else>
      {{ $t('quotaFooter.noData') }}
    </q-tooltip>
  </span>
</template>

<style lang="scss" scoped>
.quota-footer {
  font-size: 0.75rem;
  color: #a0a0c0;
  white-space: nowrap;
  cursor: default;
}
.quota-footer--empty {
  color: #6a6a8a;
}
</style>
