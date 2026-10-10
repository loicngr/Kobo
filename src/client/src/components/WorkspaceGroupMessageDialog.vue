<template>
  <q-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)">
    <q-card class="group-message-dialog bg-kobo-surface text-kobo">
      <q-card-section>
        <div class="text-h6">{{ $t('groupMessage.title') }}</div>
        <div class="text-caption text-kobo-3 q-mt-xs">{{ $t('groupMessage.description') }}</div>
      </q-card-section>
      <q-separator dark />
      <q-card-section v-if="!request">
        <div class="row q-col-gutter-md">
          <q-select v-model="tags" :options="availableTags" multiple outlined dense class="col-12 col-sm-6"
            :label="$t('groupMessage.tags')" data-test="tags" />
          <q-select v-model="statuses" :options="statusOptions" multiple emit-value map-options outlined dense
            class="col-12 col-sm-6" :label="$t('groupMessage.statuses')" data-test="statuses" />
        </div>
        <div class="text-caption text-kobo-3 q-mt-sm">{{ $t('groupMessage.filtersHint') }}</div>
        <q-checkbox v-model="devServerRunning" dense class="q-mt-sm" data-test="dev-server-running"
          :label="$t('groupMessage.devServerRunning')" />
        <div class="row items-center justify-between q-mt-md">
          <span class="text-weight-medium">{{ $t('groupMessage.selected', { count: selectedIds.length }) }}</span>
          <div>
            <q-btn flat dense no-caps :label="$t('groupMessage.selectAll')" @click="excluded = []" />
            <q-btn flat dense no-caps :label="$t('groupMessage.selectNone')" @click="excluded = matches.map(w => w.id)" />
          </div>
        </div>
        <div class="group-message-recipients q-mt-sm">
          <div v-for="workspace in matches" :key="workspace.id" :data-recipient="workspace.id" class="group-message-recipient">
            <q-checkbox :model-value="!excluded.includes(workspace.id)" :label="workspace.name"
              @update:model-value="toggle(workspace.id, $event)" />
            <span class="text-caption text-kobo-3">{{ statusLabel(workspace.status) }} · {{ $t(workspace.autoLoop ? 'groupMessage.nextIteration' : 'groupMessage.immediate') }}</span>
          </div>
          <p v-if="matches.length === 0" class="text-caption text-kobo-3">{{ $t('groupMessage.empty') }}</p>
        </div>
        <q-input v-model="content" type="textarea" outlined autogrow class="q-mt-md" :maxlength="100_000"
          :label="$t('groupMessage.content')" />
        <p class="text-caption text-kobo-3 q-mb-none">{{ $t('groupMessage.deliveryHint') }}</p>
        <p v-if="selectedIds.length > 200" class="text-negative">{{ $t('groupMessage.limit') }}</p>
      </q-card-section>
      <q-card-section v-else aria-live="polite">
        <div class="text-weight-medium">{{ $t(batch?.complete ? 'groupMessage.finished' : 'groupMessage.inProgress') }}</div>
        <p class="text-caption text-kobo-3">{{ $t('groupMessage.serverContinues') }}</p>
        <div v-for="recipient in batch?.recipients ?? []" :key="recipient.workspaceId" class="group-message-result" :data-result="recipient.workspaceId">
          <div class="row items-center justify-between q-gutter-sm">
            <span class="text-weight-medium">{{ recipient.name }}</span>
            <span :class="resultClass(recipient.state)">{{ $t(`groupMessage.state.${recipient.state}`) }}</span>
          </div>
          <div v-if="recipient.error" class="text-caption text-kobo-3">{{ recipient.error }}</div>
        </div>
        <p v-if="batch?.recipients.some(r => r.state === 'unknown')" class="text-warning">{{ $t('groupMessage.unknownHint') }}</p>
      </q-card-section>
      <q-card-section v-if="error" class="text-negative" role="alert">
        {{ error }}
        <div v-if="request" class="text-caption q-mt-xs">{{ $t('groupMessage.retryHint') }}</div>
      </q-card-section>
      <q-separator dark />
      <q-card-actions align="right">
        <q-btn flat no-caps :label="$t('common.close')" @click="emit('update:modelValue', false)" />
        <q-btn v-if="request && error" flat no-caps :loading="busy" :label="$t('groupMessage.retry')" @click="retry" />
        <q-btn v-if="batch?.complete" flat no-caps :label="$t('groupMessage.newMessage')" @click="newMessage" />
        <q-btn v-if="!request" unelevated no-caps color="primary" data-test="send" :loading="busy"
          :disable="!content.trim() || selectedIds.length === 0 || selectedIds.length > 200"
          :label="$t('groupMessage.send', { count: selectedIds.length })" @click="send(selectedIds, content)" />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { matchesGroupMessageFilters } from '../../../shared/workspace-group-messages'
import { useGroupMessages } from '../composables/use-group-messages'
import { useDevServerStore } from '../stores/dev-server'
import { useSettingsStore } from '../stores/settings'
import { WORKSPACE_STATUSES, workspaceStatusKey } from '../utils/workspace-status'
import { collectTags } from '../utils/workspace-tag-filter'

interface RecipientWorkspace {
  id: string
  name: string
  tags: string[]
  status: string
  autoLoop?: boolean
  devServerStatus?: string
  archivedAt: string | null
  worktreePurgedAt: string | null
}
const props = defineProps<{ modelValue: boolean; workspaces: RecipientWorkspace[] }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const { t } = useI18n()
const settingsStore = useSettingsStore()
const devServerStore = useDevServerStore()
const { request, batch, busy, error, send, retry, refresh, reset } = useGroupMessages()
const tags = ref<string[]>([])
const statuses = ref<string[]>([])
const devServerRunning = ref(false)
const excluded = ref<string[]>([])
const DRAFT_KEY = 'kobo:group-message-draft'
const content = ref(readDraft())
function readDraft() {
  try {
    return sessionStorage.getItem(DRAFT_KEY) ?? ''
  } catch {
    return ''
  }
}
watch(content, (value) => {
  try {
    sessionStorage.setItem(DRAFT_KEY, value)
  } catch {
    /* Preserve draft in memory. */
  }
})
const live = computed(() => props.workspaces.filter((w) => !w.archivedAt && !w.worktreePurgedAt))
const availableTags = computed(() => collectTags(live.value, settingsStore.global.tags).map((item) => item.tag))
const matches = computed(() =>
  live.value.filter((w) =>
    matchesGroupMessageFilters(
      { ...w, devServerStatus: devServerStore.getStatus(w.id)?.status ?? w.devServerStatus },
      { tags: tags.value, statuses: statuses.value, devServerRunning: devServerRunning.value },
    ),
  ),
)
const selectedIds = computed(() => matches.value.filter((w) => !excluded.value.includes(w.id)).map((w) => w.id))
const statusOptions = computed(() => WORKSPACE_STATUSES.map((value) => ({ value, label: statusLabel(value) })))
function statusLabel(status: string) {
  const key = workspaceStatusKey(status)
  return key ? t(key) : status
}
function toggle(id: string, selected: boolean) {
  excluded.value = selected ? excluded.value.filter((value) => value !== id) : [...new Set([...excluded.value, id])]
}
function resultClass(state: string) {
  return state === 'sent' || state === 'queued'
    ? 'text-positive'
    : state === 'rejected' || state === 'unknown' || state === 'not_sent'
      ? 'text-warning'
      : 'text-kobo-3'
}
function newMessage() {
  reset()
  content.value = ''
  excluded.value = []
}
watch(
  () => props.modelValue,
  (open) => {
    if (open && request.value) void refresh()
  },
  { immediate: true },
)
</script>

<style scoped lang="scss">
.group-message-dialog { width: min(90vw, 45rem); max-width: 100%; }
.group-message-recipients { max-height: 30vh; overflow: auto; border-block: 1px solid var(--kobo-border-subtle); }
.group-message-recipient { display: flex; flex-direction: column; align-items: flex-start; padding: var(--kobo-space-xs) 0; }
.group-message-recipient > span { padding-inline-start: var(--kobo-space-lg); }
.group-message-result { padding-block: var(--kobo-space-sm); border-bottom: 1px solid var(--kobo-border-subtle); overflow-wrap: anywhere; }
</style>
