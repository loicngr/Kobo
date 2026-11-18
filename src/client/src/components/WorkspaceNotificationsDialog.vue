<template>
  <q-dialog
    :model-value="modelValue"
    :aria-label="$t('workspaceNotifications.title', { name: shownName })"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <q-card v-if="workspaceId" dark class="full-width">
      <q-card-section>
        <div class="text-subtitle1">{{ $t('workspaceNotifications.title', { name: shownName }) }}</div>
        <div class="text-caption text-kobo-3 q-mt-xs">{{ $t('workspaceNotifications.intro') }}</div>
      </q-card-section>
      <q-card-section class="q-pt-none column q-gutter-y-xs">
        <div class="text-caption text-kobo-3">{{ $t('workspaceNotifications.muteHeading') }}</div>
        <q-checkbox
          v-for="channel in channels"
          :key="channel.key"
          dense
          dark
          :disable="!workspace"
          :aria-describedby="channel.key === 'muteDrawer' && prefs.muteDrawer ? DRAWER_HINT_ID : undefined"
          :model-value="prefs[channel.key]"
          :label="$t(channel.label)"
          @update:model-value="set(channel.key, $event)"
        />
        <div v-if="prefs.muteDrawer" :id="DRAWER_HINT_ID" class="text-caption text-kobo-3">
          {{ $t('workspaceNotifications.drawerHint') }}
        </div>
        <q-checkbox
          class="q-mt-sm"
          dense
          dark
          :disable="!keepEnabled || !workspace"
          :aria-describedby="keepDescribedBy"
          :model-value="prefs.keepQuestions"
          :label="$t('workspaceNotifications.keepQuestions')"
          @update:model-value="set('keepQuestions', $event)"
        />
        <div :id="KEEP_HINT_ID" class="text-caption text-kobo-3">{{ $t('workspaceNotifications.keepQuestionsHint') }}</div>
        <div v-if="!keepEnabled" :id="KEEP_DISABLED_ID" class="text-caption text-kobo-3">
          {{ $t('workspaceNotifications.keepQuestionsDisabled') }}
        </div>
        <div v-if="failed" role="alert" class="text-caption text-negative q-mt-sm">
          {{ $t('workspaceNotifications.error') }}
        </div>
      </q-card-section>
      <q-card-actions align="right" class="q-gutter-xs">
        <q-btn
          flat
          no-caps
          :disable="!workspace"
          :label="$t('workspaceNotifications.muteAll')"
          @click="apply(withAllMuted(prefs, true))"
        />
        <q-btn
          flat
          no-caps
          :disable="!workspace"
          :label="$t('workspaceNotifications.restoreAll')"
          @click="apply(withAllMuted(prefs, false))"
        />
        <q-btn color="primary" no-caps :label="$t('common.close')" @click="emit('update:modelValue', false)" />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { useWorkspaceStore } from 'src/stores/workspace'
import { computed, ref, watch, watchEffect } from 'vue'
import {
  DEFAULT_WORKSPACE_NOTIFICATION_PREFS,
  type WorkspaceNotificationPrefs,
  withAllMuted,
} from '../../../shared/workspace-notifications'

const props = defineProps<{
  modelValue: boolean
  workspaceId: string | null
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const DRAWER_HINT_ID = 'kobo-ws-notif-drawer-hint'
const KEEP_HINT_ID = 'kobo-ws-notif-keep-hint'
const KEEP_DISABLED_ID = 'kobo-ws-notif-keep-disabled'

const store = useWorkspaceStore()

const channels = [
  { key: 'muteBrowser', label: 'workspaceNotifications.indicator.browser' },
  { key: 'muteSound', label: 'workspaceNotifications.indicator.sound' },
  { key: 'muteToast', label: 'workspaceNotifications.indicator.toast' },
  { key: 'muteDrawer', label: 'workspaceNotifications.indicator.drawer' },
] as const

const workspace = computed(() =>
  props.workspaceId
    ? (store.workspaces.find((w) => w.id === props.workspaceId) ??
      store.archivedWorkspaces.find((w) => w.id === props.workspaceId))
    : undefined,
)

// Last known values: while the workspace is in neither list (archived, list not reloaded yet) the
// dialog keeps showing them, read-only, instead of falling back to defaults.
const known = ref<{ id: string; name: string; prefs: WorkspaceNotificationPrefs } | null>(null)
watchEffect(() => {
  const ws = workspace.value
  if (ws)
    known.value = { id: ws.id, name: ws.name, prefs: ws.notificationPrefs ?? DEFAULT_WORKSPACE_NOTIFICATION_PREFS }
})
const stale = computed(() => (known.value?.id === props.workspaceId ? known.value : null))
const shownName = computed(() => workspace.value?.name ?? stale.value?.name ?? '')

// No local copy of a live value: the store is optimistic and rolls back by itself, and it follows other tabs.
const prefs = computed<WorkspaceNotificationPrefs>(() =>
  workspace.value
    ? (workspace.value.notificationPrefs ?? DEFAULT_WORKSPACE_NOTIFICATION_PREFS)
    : (stale.value?.prefs ?? DEFAULT_WORKSPACE_NOTIFICATION_PREFS),
)
const keepEnabled = computed(() => prefs.value.muteSound || prefs.value.muteToast)
const keepDescribedBy = computed(() => (keepEnabled.value ? KEEP_HINT_ID : `${KEEP_HINT_ID} ${KEEP_DISABLED_ID}`))

const failed = ref(false)

function apply(next: WorkspaceNotificationPrefs) {
  const id = props.workspaceId
  if (!id || !workspace.value) return
  failed.value = false
  store.setNotificationPrefs(id, next).catch(() => {
    // A late failure of another workspace's save must not show here.
    if (props.workspaceId === id && props.modelValue) failed.value = true
  })
}

function set(key: keyof WorkspaceNotificationPrefs, value: boolean) {
  apply({ ...prefs.value, [key]: value })
}

// Archiving moves a workspace between lists: confirm it is really gone before closing. A fetch the
// store drops (superseded by a newer one, or by a lifecycle change) proves nothing, so it is retried.
const MAX_GONE_CHECKS = 3
let checking = false
let recheck = false

const stillGone = (id: string) => props.modelValue && props.workspaceId === id && !workspace.value

async function confirmGone(id: string): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_GONE_CHECKS; attempt++) {
    const pending = store.fetchArchivedWorkspaces() // bumps archivedListRequestVersion synchronously
    const requestVersion = store.archivedListRequestVersion
    const lifecycleVersion = store.workspaceLifecycleVersion
    try {
      await pending
    } catch {
      /* the checks below decide */
    }
    if (!stillGone(id)) return false
    const superseded =
      store.archivedListRequestVersion !== requestVersion || store.workspaceLifecycleVersion !== lifecycleVersion
    if (!superseded) return true
  }
  return true
}

async function closeIfGone(firstId: string) {
  if (checking) {
    recheck = true // one chain at a time: the running one re-evaluates when it ends
    return
  }
  checking = true
  try {
    let id: string | null = firstId
    while (id) {
      recheck = false
      if (await confirmGone(id)) emit('update:modelValue', false)
      const next: string | null =
        recheck && props.workspaceId && stillGone(props.workspaceId) ? props.workspaceId : null
      id = next
    }
  } finally {
    checking = false
  }
}
watch(
  () => (props.modelValue && props.workspaceId && !workspace.value ? props.workspaceId : null),
  (id) => {
    if (id) void closeIfGone(id)
  },
  { immediate: true },
)
watch(
  () => props.modelValue,
  () => {
    failed.value = false
  },
)
</script>
