<template>
  <div v-if="reasons.length > 0" class="text-caption q-mt-xs">
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
  </div>
</template>

<script setup lang="ts">
import { useQuasar } from 'quasar'
import type { Workspace } from 'src/stores/workspace'
import { useWorkspaceStore } from 'src/stores/workspace'
import { useTimeAgo } from 'src/utils/formatters'
import type { AttentionKind } from 'src/utils/workspace-attention'
import { getAttentionReasons } from 'src/utils/workspace-attention'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ workspace: Workspace }>()

const store = useWorkspaceStore()
const $q = useQuasar()
const { t } = useI18n()
const { timeAgo } = useTimeAgo()

const reasons = computed(() => getAttentionReasons(props.workspace, store.prSnapshots[props.workspace.id]))

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
    default:
      return kind // 'error' | 'quota' — raw, matching the prior card behaviour
  }
}
</script>
