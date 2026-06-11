<template>
  <div v-if="(!ciRecapOnly && reasons.length > 0) || ciRunning" class="text-caption q-mt-xs">
    <template v-if="!ciRecapOnly">
      <div
        v-for="(reason, i) in reasons"
        :key="reason.kind"
        class="row items-center no-wrap"
      >
        <q-icon :name="reason.icon" size="xs" :color="reason.color" class="q-mr-xs" />
        <span :class="`text-${reason.color}`">{{ labelFor(reason.kind) }}</span>
        <q-btn
          v-if="reason.kind === 'ci-failed' && !workspace.archivedAt"
          flat
          dense
          round
          size="xs"
          color="red-4"
          icon="build_circle"
          class="q-ml-xs"
          :loading="fixingCi"
          :disable="fixingCi"
          @click.stop="onFixCi"
        >
          <q-tooltip>{{ t('tools.fixCiTooltip') }}</q-tooltip>
        </q-btn>
        <span v-if="i === reasons.length - 1" class="q-ml-xs text-grey-8">
          &middot; {{ timeAgo(workspace.updatedAt) }}
        </span>
      </div>
    </template>

    <!-- Compact CI recap, only while CI is still running (pending checks). The
         failed / ready-to-merge end states are already covered by the attention
         badges above. Hover lists the in-flight job names, one per line. -->
    <div v-if="ciRunning" class="row items-center no-wrap ci-recap">
      <q-icon name="hourglass_empty" size="12px" color="amber-5" class="q-mr-xs" />
      <span class="text-amber-5">{{ t('git.pr.ci.pendingCount', { n: ciSummary.pending.length }) }}</span>
      <span class="q-mx-xs text-grey-7">&middot;</span>
      <q-icon name="check_circle" size="12px" color="green-5" class="q-mr-xs" />
      <span class="text-grey-5">{{ ciSummary.passed.length }}</span>
      <template v-if="ciSummary.skipped.length > 0">
        <span class="q-mx-xs text-grey-7">&middot;</span>
        <q-icon name="remove_circle_outline" size="12px" color="grey-6" class="q-mr-xs" />
        <span class="text-grey-6">{{ ciSummary.skipped.length }}</span>
      </template>
      <template v-if="ciSummary.failed.length > 0">
        <span class="q-mx-xs text-grey-7">&middot;</span>
        <q-icon name="cancel" size="12px" color="red-5" class="q-mr-xs" />
        <span class="text-red-5">{{ ciSummary.failed.length }}</span>
      </template>
      <q-tooltip anchor="bottom start" self="top start" class="ci-recap-tooltip">
        <div class="text-weight-medium text-amber-4 q-mb-xs row items-center no-wrap">
          <q-icon name="hourglass_empty" size="13px" class="q-mr-xs" />
          {{ t('git.pr.ci.pendingCount', { n: ciSummary.pending.length }) }}
        </div>
        <div v-for="c in ciSummary.pending" :key="c.name" class="ci-recap-tooltip__job">
          {{ c.name }}
        </div>
        <div v-if="ciSummary.failed.length > 0" class="text-red-4 q-mt-xs">
          {{ t('git.pr.ci.failedCount', { n: ciSummary.failed.length }) }}
        </div>
        <div class="text-grey-5 q-mt-xs">
          {{ t('git.pr.ci.passedCount', { n: ciSummary.passed.length }) }} &middot;
          {{ t('git.pr.ci.skippedCount', { n: ciSummary.skipped.length }) }}
        </div>
      </q-tooltip>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useQuasar } from 'quasar'
import type { Workspace } from 'src/stores/workspace'
import { useWorkspaceStore } from 'src/stores/workspace'
import { summarizeCiChecks } from 'src/utils/ci-summary'
import { useTimeAgo } from 'src/utils/formatters'
import type { AttentionKind } from 'src/utils/workspace-attention'
import { getAttentionReasons } from 'src/utils/workspace-attention'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  workspace: Workspace
  /** Render only the in-flight CI recap, hiding the attention reasons. Used on
   *  the non-attention card groups (Running / Idle) where status labels aren't
   *  wanted but a running pipeline should still surface. */
  ciRecapOnly?: boolean
}>()

const store = useWorkspaceStore()
const $q = useQuasar()
const { t } = useI18n()
const { timeAgo } = useTimeAgo()

const reasons = computed(() => getAttentionReasons(props.workspace, store.prSnapshots[props.workspace.id]))

// Compact CI recap, surfaced only while the CI is still in flight.
const ciSummary = computed(() => summarizeCiChecks(store.prSnapshots[props.workspace.id]?.ci.checks ?? []))
const ciRunning = computed(() => ciSummary.value.pending.length > 0)

const fixingCi = ref(false)

async function onFixCi() {
  if (fixingCi.value) return
  fixingCi.value = true
  try {
    const res = await fetch(`/api/workspaces/${props.workspace.id}/start-ci-fix`, { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      $q.notify({
        type: 'negative',
        message: data.error ?? t('tools.fixCiFailed'),
        position: 'top',
        timeout: 6000,
      })
      return
    }
    $q.notify({ type: 'positive', message: t('tools.fixCiLaunched'), position: 'top', timeout: 3000 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : t('tools.fixCiFailed')
    $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
  } finally {
    fixingCi.value = false
  }
}

function labelFor(kind: AttentionKind): string {
  switch (kind) {
    case 'awaiting-user':
      return t('workspaceStatus.awaitingUser')
    case 'ci-failed':
      return t('workspaceList.attentionCiFailed')
    case 'changes-requested':
      return t('workspaceList.attentionChangesRequested')
    case 'ready-to-merge':
      return t('workspaceList.attentionReadyToMerge')
    default:
      return kind // 'error' | 'quota' — raw, matching the prior card behaviour
  }
}
</script>

<style scoped>
.ci-recap-tooltip__job {
  white-space: nowrap;
  line-height: 1.5;
}
</style>
