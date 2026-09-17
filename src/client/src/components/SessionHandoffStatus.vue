<template>
  <section v-if="handoff && handoff.state !== 'cancelled'" class="handoff-status q-mt-sm q-pt-sm" :aria-label="$t('handoff.status')">
    <div class="row items-center no-wrap text-caption text-kobo-2" role="status" aria-live="polite">
      <q-spinner v-if="handoffs.isActive(workspaceId)" size="14px" class="q-mr-xs" />
      <span>{{ $t(`handoff.${handoff.state}`) }}</span>
    </div>
    <div v-if="handoff.error" class="text-caption text-negative q-mt-xs">{{ handoff.error }}</div>
    <div v-if="needsDecision" class="q-mt-sm">
      <q-btn data-test="handoff-retry" dense flat no-caps :label="$t('common.retry')" :disable="busy" @click="decide('retry')" />
      <q-btn data-test="handoff-skip" dense flat no-caps :label="$t('handoff.skip')" :disable="busy" @click="decide('skip')" />
    </div>
    <q-btn v-if="handoffs.isBlocking(workspaceId)" data-test="handoff-cancel" dense flat no-caps :label="$t('handoff.cancel')" :loading="busy" @click="decide('cancel')" />
    <div class="row q-gutter-xs q-mt-xs">
      <q-btn v-if="handoff.sourceSessionId" data-test="handoff-source" dense flat no-caps size="sm" :label="$t('handoff.source')" @click="workspace.selectSession(handoff.sourceSessionId)" />
      <q-btn v-if="handoff.reportPath" data-test="handoff-report" dense flat no-caps size="sm" :label="$t('handoff.report')" @click="openReport" />
    </div>
  </section>
  <div v-else-if="handoffs.loadErrors[workspaceId]" class="text-caption text-negative q-mt-xs">
    {{ $t('handoff.loadFailed') }}
    <q-btn dense flat no-caps :label="$t('common.retry')" @click="handoffs.refresh(workspaceId).catch(() => {})" />
  </div>
</template>

<script setup lang="ts">
import { useQuasar } from 'quasar'
import { useDocumentsStore } from 'src/stores/documents'
import { useSessionHandoffStore } from 'src/stores/session-handoff'
import { useWorkspaceStore } from 'src/stores/workspace'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ workspaceId: string }>()
const handoffs = useSessionHandoffStore()
const workspace = useWorkspaceStore()
const documents = useDocumentsStore()
const $q = useQuasar()
const { t } = useI18n()
const busy = ref(false)
const handoff = computed(() => handoffs.current[props.workspaceId])
const needsDecision = computed(() => handoff.value?.state === 'failed' || handoff.value?.state === 'interrupted')
function reportError(error: unknown) {
  $q.notify({ type: 'negative', message: error instanceof Error ? error.message : t('handoff.error'), position: 'top' })
}
async function decide(action: 'retry' | 'skip' | 'cancel') {
  if (!handoff.value || busy.value) return
  busy.value = true
  try {
    await handoffs.decide(props.workspaceId, handoff.value.id, action)
  } catch (error) {
    reportError(error)
  } finally {
    busy.value = false
  }
}
async function openReport() {
  if (!handoff.value?.reportPath) return
  try {
    if (!(await documents.openDocumentByPath(props.workspaceId, handoff.value.reportPath)))
      reportError(new Error(t('documents.loadFailed')))
  } catch (error) {
    reportError(error)
  }
}
</script>

<style scoped>
.handoff-status { border-top: 1px solid var(--kobo-border-subtle); }
</style>
