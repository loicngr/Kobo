<template>
  <q-btn
    v-bind="$attrs"
    no-caps dense outline color="primary" :icon="mode === 'fresh' ? 'restart_alt' : 'swap_horiz'"
    :label="$t(mode === 'fresh' ? 'handoff.freshTitle' : 'handoff.switchTitle')"
    :disable="blocked" class="full-width q-mb-xs" @click="isOpen = true"
  />
  <SessionHandoffDialog
    v-model="isOpen" :workspace="workspace" :source-session-id="currentSession?.id ?? null"
    :mode="mode" :loading="submitting" @submit="submit"
  />
</template>

<script setup lang="ts">
import { useQuasar } from 'quasar'
import SessionHandoffDialog from 'src/components/SessionHandoffDialog.vue'
import { useSessionHandoffStore } from 'src/stores/session-handoff'
import { useWorkspaceStore, type Workspace } from 'src/stores/workspace'
import { getCurrentSession } from 'src/utils/current-session'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SessionHandoffRequest } from '../../../shared/session-handoff'

defineOptions({ inheritAttrs: false })
const props = withDefaults(defineProps<{ workspace: Workspace; mode?: 'fresh' | 'switch' }>(), { mode: 'switch' })
const emit = defineEmits<(e: 'started', workspaceId: string) => void>()
const store = useWorkspaceStore()
const handoffs = useSessionHandoffStore()
const $q = useQuasar()
const { t } = useI18n()
const isOpen = ref(false)
const submitting = ref(false)
const blocked = computed(
  () => !!props.workspace.archivedAt || !!props.workspace.worktreePurgedAt || handoffs.isBlocking(props.workspace.id),
)
const currentSession = computed(() =>
  getCurrentSession(
    store.sessions.filter((session) => session.workspaceId === props.workspace.id && session.status !== 'idle'),
  ),
)
async function submit(input: SessionHandoffRequest) {
  if (submitting.value || blocked.value) return
  const workspaceId = props.workspace.id
  submitting.value = true
  try {
    await handoffs.start(workspaceId, input)
    isOpen.value = false
    emit('started', workspaceId)
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: error instanceof Error ? error.message : t('handoff.error'),
      position: 'top',
    })
    // A timeout may have hidden an accepted operation. Recover its durable status before retrying.
    await handoffs.refresh(workspaceId).catch(() => {})
    if (handoffs.isBlocking(workspaceId)) {
      isOpen.value = false
      emit('started', workspaceId)
    }
  } finally {
    submitting.value = false
  }
}
</script>
