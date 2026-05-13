<template>
  <div class="pr-panel">
    <!-- Header row -->
    <div class="pr-panel__header row items-center q-gutter-xs">
      <q-chip
        dense
        square
        :color="snapshot.state === 'OPEN' ? 'green-9' : 'grey-9'"
        :text-color="snapshot.state === 'OPEN' ? 'green-3' : 'grey-3'"
        :label="snapshot.state"
        class="pr-panel__state"
      />
      <a
        :href="snapshot.url"
        target="_blank"
        rel="noopener"
        class="pr-panel__number"
      >#{{ snapshot.number }}</a>
      <span class="pr-panel__title col ellipsis">{{ snapshot.title }}</span>
      <q-tooltip v-if="snapshot.title.length > 60" anchor="bottom middle" self="top middle">
        {{ snapshot.title }}
      </q-tooltip>
      <q-chip
        v-if="isChangesRequestedBlocking(snapshot)"
        dense square
        color="red-9"
        text-color="red-3"
        icon="rate_review"
        :label="$t('git.pr.changesRequestedBadge')"
        class="pr-panel__badge"
      />
      <q-chip
        v-else-if="snapshot.reviewDecision === 'APPROVED'"
        dense square
        color="green-9"
        text-color="green-3"
        icon="check"
        :label="$t('git.pr.approvedBadge')"
        class="pr-panel__badge"
      />
    </div>

    <!-- Grid rows -->
    <div class="pr-panel__grid">
      <span class="pr-panel__label">{{ $t('git.pr.author') }}</span>
      <span class="pr-panel__value">@{{ snapshot.author.login }}</span>

      <template v-if="snapshot.reviewers.length > 0">
        <span class="pr-panel__label">{{ $t('git.pr.reviewers') }}</span>
        <span class="pr-panel__value pr-panel__reviewers">
          <span
            v-for="r in snapshot.reviewers"
            :key="r.login"
            class="pr-panel__reviewer"
          >
            <span class="pr-panel__dot" :style="{ backgroundColor: reviewerColor(r.state) }" />
            <span>@{{ r.login }}</span>
            <q-tooltip>{{ r.login }} — {{ r.state.toLowerCase() }}</q-tooltip>
          </span>
        </span>
      </template>

      <template v-if="snapshot.assignees.length > 0">
        <span class="pr-panel__label">{{ $t('git.pr.assignees') }}</span>
        <span class="pr-panel__value">{{ snapshot.assignees.map((a) => '@' + a.login).join(', ') }}</span>
      </template>

      <template v-if="snapshot.labels.length > 0">
        <span class="pr-panel__label">{{ $t('git.pr.labels') }}</span>
        <span class="pr-panel__value">
          <q-chip
            v-for="l in snapshot.labels"
            :key="l.name"
            dense square
            :style="{ backgroundColor: '#' + l.color, color: pickReadableForeground(l.color) }"
            class="pr-panel__label-chip"
            :label="l.name"
          />
        </span>
      </template>
    </div>

    <!-- CI footer -->
    <div v-if="snapshot.ci.rollup !== null" class="pr-panel__ci">
      <!-- Summary header: icon + label + counts -->
      <div class="row items-center q-gutter-sm pr-panel__ci-summary">
        <q-icon :name="ciIcon" :color="ciColor" size="16px" />
        <span class="pr-panel__ci-label">{{ ciLabel }}</span>
        <div class="row items-center q-gutter-sm pr-panel__ci-counts">
          <span v-if="ciGroups.failed.length > 0" class="pr-panel__ci-count pr-panel__ci-count--failed">
            <q-icon name="cancel" size="12px" />
            <span>{{ $t('git.pr.ci.failedCount', { n: ciGroups.failed.length }) }}</span>
          </span>
          <span v-if="ciGroups.pending.length > 0" class="pr-panel__ci-count pr-panel__ci-count--pending">
            <q-icon name="hourglass_top" size="12px" />
            <span>{{ $t('git.pr.ci.pendingCount', { n: ciGroups.pending.length }) }}</span>
          </span>
          <span v-if="ciGroups.passed.length > 0" class="pr-panel__ci-count pr-panel__ci-count--passed">
            <q-icon name="check_circle" size="12px" />
            <span>{{ $t('git.pr.ci.passedCount', { n: ciGroups.passed.length }) }}</span>
          </span>
          <span v-if="ciGroups.skipped.length > 0" class="pr-panel__ci-count pr-panel__ci-count--skipped">
            <q-icon name="remove_circle_outline" size="12px" />
            <span>{{ $t('git.pr.ci.skippedCount', { n: ciGroups.skipped.length }) }}</span>
          </span>
        </div>
      </div>

      <!-- Failed checks: always visible -->
      <div v-if="ciGroups.failed.length > 0" class="pr-panel__ci-list q-mt-sm">
        <component
          :is="c.detailsUrl ? 'a' : 'div'"
          v-for="c in ciGroups.failed"
          :key="`f-${c.name}-${c.detailsUrl ?? ''}`"
          :href="c.detailsUrl ?? undefined"
          target="_blank"
          rel="noopener"
          class="pr-panel__ci-item pr-panel__ci-item--failed"
        >
          <q-icon name="cancel" size="14px" />
          <span class="ellipsis">{{ c.name }}</span>
        </component>
      </div>

      <!-- Pending checks: always visible -->
      <div v-if="ciGroups.pending.length > 0" class="pr-panel__ci-list q-mt-xs">
        <component
          :is="c.detailsUrl ? 'a' : 'div'"
          v-for="c in ciGroups.pending"
          :key="`p-${c.name}-${c.detailsUrl ?? ''}`"
          :href="c.detailsUrl ?? undefined"
          target="_blank"
          rel="noopener"
          class="pr-panel__ci-item pr-panel__ci-item--pending"
        >
          <q-icon name="hourglass_top" size="14px" />
          <span class="ellipsis">{{ c.name }}</span>
        </component>
      </div>

      <!-- Passed/skipped checks: collapsed by default -->
      <div v-if="ciGroups.passed.length + ciGroups.skipped.length > 0" class="q-mt-xs">
        <q-btn
          dense flat no-caps size="sm"
          :icon="showPassed ? 'expand_less' : 'expand_more'"
          :label="showPassed ? $t('git.pr.ci.hidePassed') : $t('git.pr.ci.showPassed', { n: ciGroups.passed.length + ciGroups.skipped.length })"
          class="pr-panel__ci-toggle"
          @click="showPassed = !showPassed"
        />
        <div v-if="showPassed" class="pr-panel__ci-list q-mt-xs">
          <component
            :is="c.detailsUrl ? 'a' : 'div'"
            v-for="c in ciGroups.passed"
            :key="`s-${c.name}-${c.detailsUrl ?? ''}`"
            :href="c.detailsUrl ?? undefined"
            target="_blank"
            rel="noopener"
            class="pr-panel__ci-item pr-panel__ci-item--passed"
          >
            <q-icon name="check_circle" size="14px" />
            <span class="ellipsis">{{ c.name }}</span>
          </component>
          <component
            :is="c.detailsUrl ? 'a' : 'div'"
            v-for="c in ciGroups.skipped"
            :key="`k-${c.name}-${c.detailsUrl ?? ''}`"
            :href="c.detailsUrl ?? undefined"
            target="_blank"
            rel="noopener"
            class="pr-panel__ci-item pr-panel__ci-item--skipped"
          >
            <q-icon name="remove_circle_outline" size="14px" />
            <span class="ellipsis">{{ c.name }}</span>
          </component>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { PrSnapshot } from 'src/stores/workspace'
import { pickReadableForeground } from 'src/utils/color'
import { isChangesRequestedBlocking } from 'src/utils/pr-status'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

type Check = PrSnapshot['ci']['checks'][number]

const props = defineProps<{ snapshot: PrSnapshot }>()
const { t } = useI18n()
const showPassed = ref(false)

function reviewerColor(state: PrSnapshot['reviewers'][number]['state']): string {
  switch (state) {
    case 'APPROVED':
      return '#4ade80'
    case 'CHANGES_REQUESTED':
      return '#ef4444'
    case 'COMMENTED':
      return '#f59e0b'
    default:
      return '#6b7280'
  }
}

const ciGroups = computed<{ failed: Check[]; pending: Check[]; passed: Check[]; skipped: Check[] }>(() => {
  const failed: Check[] = []
  const pending: Check[] = []
  const passed: Check[] = []
  const skipped: Check[] = []
  for (const c of props.snapshot.ci.checks) {
    if (c.status !== 'COMPLETED') {
      pending.push(c)
      continue
    }
    if (c.conclusion === 'FAILURE' || c.conclusion === 'CANCELLED' || c.conclusion === 'TIMED_OUT') {
      failed.push(c)
    } else if (c.conclusion === 'SUCCESS') {
      passed.push(c)
    } else {
      // SKIPPED / NEUTRAL / unknown
      skipped.push(c)
    }
  }
  const byName = (a: Check, b: Check) => a.name.localeCompare(b.name)
  failed.sort(byName)
  pending.sort(byName)
  passed.sort(byName)
  skipped.sort(byName)
  return { failed, pending, passed, skipped }
})

const ciIcon = computed(() => {
  switch (props.snapshot.ci.rollup) {
    case 'SUCCESS':
      return 'check_circle'
    case 'FAILURE':
      return 'cancel'
    case 'PENDING':
      return 'hourglass_top'
    default:
      return 'help'
  }
})

const ciColor = computed(() => {
  switch (props.snapshot.ci.rollup) {
    case 'SUCCESS':
      return 'green-4'
    case 'FAILURE':
      return 'red-4'
    case 'PENDING':
      return 'amber-4'
    default:
      return 'grey-5'
  }
})

const ciLabel = computed(() => {
  switch (props.snapshot.ci.rollup) {
    case 'SUCCESS':
      return t('git.pr.ci.passed')
    case 'FAILURE':
      return t('git.pr.ci.failed')
    case 'PENDING':
      return t('git.pr.ci.pending')
    default:
      return ''
  }
})
</script>

<style scoped lang="scss">
.pr-panel__header {
  padding-bottom: 8px;
  border-bottom: 1px solid #2a2a4a;
}
.pr-panel__number {
  color: #a5b4fc;
  font-weight: 600;
  text-decoration: none;
  font-size: 12px;
}
.pr-panel__title {
  color: #ddd;
  font-size: 12px;
}
.pr-panel__state, .pr-panel__badge, .pr-panel__label-chip {
  font-size: 10px;
  font-weight: 600;
}
.pr-panel__grid {
  display: grid;
  grid-template-columns: 90px 1fr;
  gap: 6px 12px;
  padding: 8px 0;
  font-size: 11px;
}
.pr-panel__label {
  color: #9ca3af;
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.05em;
  align-self: center;
}
.pr-panel__value {
  color: #ddd;
}
.pr-panel__reviewers {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
}
.pr-panel__reviewer {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.pr-panel__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  display: inline-block;
}
.pr-panel__ci {
  padding-top: 8px;
  border-top: 1px solid #2a2a4a;
  font-size: 11px;
  color: #ddd;
}
.pr-panel__ci-summary {
  flex-wrap: wrap;
}
.pr-panel__ci-counts {
  flex-wrap: wrap;
}
.pr-panel__ci-count {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 3px;
  background-color: rgba(255, 255, 255, 0.04);
}
.pr-panel__ci-count--failed { color: #fca5a5; }
.pr-panel__ci-count--pending { color: #fcd34d; }
.pr-panel__ci-count--passed { color: #86efac; }
.pr-panel__ci-count--skipped { color: #9ca3af; }
.pr-panel__ci-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pr-panel__ci-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 6px;
  font-size: 11px;
  border-radius: 3px;
  text-decoration: none;
  min-width: 0;
}
a.pr-panel__ci-item:hover {
  background-color: rgba(255, 255, 255, 0.05);
  text-decoration: underline;
}
.pr-panel__ci-item--failed { color: #fca5a5; }
.pr-panel__ci-item--pending { color: #fcd34d; }
.pr-panel__ci-item--passed { color: #86efac; }
.pr-panel__ci-item--skipped { color: #9ca3af; }
.pr-panel__ci-toggle {
  color: #9ca3af;
  font-size: 10px;
}
</style>
