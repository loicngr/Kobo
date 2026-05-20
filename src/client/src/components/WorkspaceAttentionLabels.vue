<template>
  <div v-if="reasons.length > 0" class="text-caption q-mt-xs">
    <div
      v-for="(reason, i) in reasons"
      :key="reason.kind"
      class="row items-center no-wrap"
    >
      <q-icon :name="reason.icon" size="xs" :color="reason.color" class="q-mr-xs" />
      <span :class="`text-${reason.color}`">{{ labelFor(reason.kind) }}</span>
      <span v-if="i === reasons.length - 1" class="q-ml-xs text-grey-8">
        &middot; {{ timeAgo(workspace.updatedAt) }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Workspace } from 'src/stores/workspace'
import { useWorkspaceStore } from 'src/stores/workspace'
import { useTimeAgo } from 'src/utils/formatters'
import type { AttentionKind } from 'src/utils/workspace-attention'
import { getAttentionReasons } from 'src/utils/workspace-attention'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ workspace: Workspace }>()

const store = useWorkspaceStore()
const { t } = useI18n()
const { timeAgo } = useTimeAgo()

const reasons = computed(() => getAttentionReasons(props.workspace, store.prSnapshots[props.workspace.id]))

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
