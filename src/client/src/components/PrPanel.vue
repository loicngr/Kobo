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
    <div v-if="snapshot.ci.rollup !== null" class="pr-panel__ci row items-center">
      <q-icon :name="ciIcon" :color="ciColor" size="16px" class="q-mr-sm" />
      <span class="pr-panel__ci-label">{{ ciLabel }}</span>
      <span v-if="snapshot.ci.checks.length > 0" class="pr-panel__ci-details q-ml-sm">
        <template v-for="c in snapshot.ci.checks" :key="c.name">
          <span :style="{ color: checkColor(c.conclusion) }" class="q-mr-sm">
            {{ c.name }} {{ checkSymbol(c.conclusion) }}
          </span>
        </template>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { PrSnapshot } from 'src/stores/workspace'
import { pickReadableForeground } from 'src/utils/color'
import { isChangesRequestedBlocking } from 'src/utils/pr-status'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ snapshot: PrSnapshot }>()
const { t } = useI18n()

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

function checkColor(conclusion: string | null): string {
  if (conclusion === 'SUCCESS') return '#4ade80'
  if (conclusion === 'FAILURE') return '#ef4444'
  return '#9ca3af'
}

function checkSymbol(conclusion: string | null): string {
  if (conclusion === 'SUCCESS') return '✓'
  if (conclusion === 'FAILURE') return '✕'
  return '⌛'
}

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
.pr-panel__ci-details {
  color: #9ca3af;
  font-size: 10px;
}
</style>
