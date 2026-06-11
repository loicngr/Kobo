<template>
  <q-menu dark context-menu>
    <q-list dense style="min-width: 180px;">
      <q-item clickable v-close-popup @click="emit('rename', workspace)">
        <q-item-section side><q-icon name="edit" size="xs" /></q-item-section>
        <q-item-section>{{ $t('contextMenu.rename') }}</q-item-section>
      </q-item>
      <q-item clickable v-close-popup @click="emit('editDescription', workspace)">
        <q-item-section side><q-icon name="description" size="xs" /></q-item-section>
        <q-item-section>{{ $t('contextMenu.editDescription') }}</q-item-section>
      </q-item>
      <q-item clickable v-close-popup @click="emit('copyPath', workspace)">
        <q-item-section side><q-icon name="content_copy" size="xs" /></q-item-section>
        <q-item-section>{{ $t('contextMenu.copyPath') }}</q-item-section>
      </q-item>
      <q-item v-if="settingsStore.global.editorCommand" clickable v-close-popup @click="emit('openEditor', workspace)">
        <q-item-section side><q-icon name="open_in_new" size="xs" /></q-item-section>
        <q-item-section>{{ $t('contextMenu.openEditor') }}</q-item-section>
      </q-item>
      <q-item
        v-if="settingsStore.global.fileManagerCommand"
        clickable
        v-close-popup
        @click="emit('openFileManager', workspace)"
      >
        <q-item-section side><q-icon name="folder_open" size="xs" /></q-item-section>
        <q-item-section>{{ $t('contextMenu.openFileManager') }}</q-item-section>
      </q-item>
      <q-item clickable v-close-popup @click="emit('runSetup', workspace)">
        <q-item-section side><q-icon name="replay" size="xs" /></q-item-section>
        <q-item-section>{{ $t('contextMenu.runSetup') }}</q-item-section>
      </q-item>
      <q-item clickable v-close-popup @click="emit('toggleFavorite', workspace)">
        <q-item-section side>
          <q-icon :name="workspace.favoritedAt ? 'star' : 'star_outline'" size="xs" />
        </q-item-section>
        <q-item-section>
          {{ workspace.favoritedAt ? $t('workspace.unfavorite') : $t('workspace.favorite') }}
        </q-item-section>
      </q-item>
      <q-item clickable v-close-popup @click="emit('manageTags', workspace)">
        <q-item-section side><q-icon name="label" size="xs" /></q-item-section>
        <q-item-section>{{ $t('tags.manage') }}</q-item-section>
      </q-item>
      <q-item v-if="workspace.notionUrl" clickable v-close-popup @click="openExternal(workspace.notionUrl)">
        <q-item-section side><q-icon name="open_in_new" size="xs" /></q-item-section>
        <q-item-section>{{ $t('contextMenu.openNotion') }}</q-item-section>
      </q-item>
      <q-item v-if="workspace.sentryUrl" clickable v-close-popup @click="openExternal(workspace.sentryUrl)">
        <q-item-section side><q-icon name="open_in_new" size="xs" /></q-item-section>
        <q-item-section>{{ $t('contextMenu.openSentry') }}</q-item-section>
      </q-item>
      <q-item v-if="prUrl" clickable v-close-popup @click="openExternal(prUrl!)">
        <q-item-section side><q-icon name="merge_type" size="xs" /></q-item-section>
        <q-item-section>{{ $t('contextMenu.openPr') }}</q-item-section>
      </q-item>
      <q-item clickable v-close-popup @click="exportEvents">
        <q-item-section side><q-icon name="download" size="xs" /></q-item-section>
        <q-item-section>{{ $t('contextMenu.exportEvents') }}</q-item-section>
      </q-item>
      <q-item
        v-if="showDismissChangesRequested"
        clickable
        v-close-popup
        @click="dismissPrAttention('changes-requested')"
      >
        <q-item-section side><q-icon name="visibility_off" size="xs" color="amber-5" /></q-item-section>
        <q-item-section>{{ $t('contextMenu.dismissChangesRequested') }}</q-item-section>
      </q-item>
      <q-item
        v-if="showDismissCiFailure"
        clickable
        v-close-popup
        @click="dismissPrAttention('ci-failed')"
      >
        <q-item-section side><q-icon name="visibility_off" size="xs" color="amber-5" /></q-item-section>
        <q-item-section>{{ $t('contextMenu.dismissCiFailure') }}</q-item-section>
      </q-item>
      <q-item
        v-if="showRestoreChangesRequested"
        clickable
        v-close-popup
        @click="restorePrAttention('changes-requested')"
      >
        <q-item-section side><q-icon name="visibility" size="xs" color="green-5" /></q-item-section>
        <q-item-section>{{ $t('contextMenu.restoreChangesRequested') }}</q-item-section>
      </q-item>
      <q-item
        v-if="showRestoreCiFailure"
        clickable
        v-close-popup
        @click="restorePrAttention('ci-failed')"
      >
        <q-item-section side><q-icon name="visibility" size="xs" color="green-5" /></q-item-section>
        <q-item-section>{{ $t('contextMenu.restoreCiFailure') }}</q-item-section>
      </q-item>
      <q-separator dark />
      <q-item
        v-if="archived"
        :clickable="!workspace.worktreePurgedAt"
        :disable="!!workspace.worktreePurgedAt"
        v-close-popup="!workspace.worktreePurgedAt"
        @click="(e) => !workspace.worktreePurgedAt && emit('unarchive', workspace, e)"
      >
        <q-item-section side><q-icon name="unarchive" size="xs" /></q-item-section>
        <q-item-section>{{ $t('common.unarchive') }}</q-item-section>
        <q-tooltip v-if="workspace.worktreePurgedAt" anchor="center left" self="center right" max-width="280px">
          {{ $t('contextMenu.unarchiveDisabledPurged') }}
        </q-tooltip>
      </q-item>
      <q-item v-else clickable v-close-popup @click="(e) => emit('archive', workspace, e)">
        <q-item-section side><q-icon name="archive" size="xs" /></q-item-section>
        <q-item-section>{{ $t('common.archive') }}</q-item-section>
      </q-item>
      <q-item
        v-if="!workspace.worktreePurgedAt && workspace.worktreeOwned !== false"
        clickable
        v-close-popup
        class="text-orange-5"
        @click="(e) => emit('purgeWorktree', workspace, e)"
      >
        <q-item-section side><q-icon name="cleaning_services" size="xs" color="orange-5" /></q-item-section>
        <q-item-section>{{ $t('contextMenu.purgeWorktree') }}</q-item-section>
        <q-tooltip>{{ $t('contextMenu.purgeWorktreeTooltip') }}</q-tooltip>
      </q-item>
      <q-item clickable v-close-popup class="text-red-5" @click="(e) => emit('delete', workspace, e)">
        <q-item-section side><q-icon name="delete_outline" size="xs" color="red-5" /></q-item-section>
        <q-item-section>{{ $t('common.delete') }}</q-item-section>
      </q-item>
    </q-list>
  </q-menu>
</template>

<script setup lang="ts">
import { useQuasar } from 'quasar'
import { useSettingsStore } from 'src/stores/settings'
import { useWorkspaceStore, type Workspace } from 'src/stores/workspace'
import { isChangesRequestedBlocking, isCiFailed } from 'src/utils/pr-status'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = withDefaults(
  defineProps<{
    workspace: Workspace
    archived?: boolean
  }>(),
  { archived: false },
)

const emit = defineEmits<{
  rename: [ws: Workspace]
  editDescription: [ws: Workspace]
  copyPath: [ws: Workspace]
  openEditor: [ws: Workspace]
  openFileManager: [ws: Workspace]
  runSetup: [ws: Workspace]
  toggleFavorite: [ws: Workspace]
  manageTags: [ws: Workspace]
  archive: [ws: Workspace, event: Event]
  unarchive: [ws: Workspace, event: Event]
  purgeWorktree: [ws: Workspace, event: Event]
  delete: [ws: Workspace, event: Event]
}>()

function openExternal(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer')
}

const $q = useQuasar()
const { t } = useI18n()

/**
 * Download every ws_event of the workspace as a CSV. Shows a sticky spinner
 * notification while the server prepares the file (the menu closes on click,
 * but the notification is global and outlives it).
 */
async function exportEvents() {
  const dismiss = $q.notify({
    spinner: true,
    message: t('contextMenu.exportingEvents'),
    timeout: 0,
    group: false,
  })
  try {
    const res = await fetch(`/api/workspaces/${props.workspace.id}/events.csv`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const slug = props.workspace.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    const a = document.createElement('a')
    a.href = url
    a.download = `${slug || 'workspace'}-events.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  } catch (err) {
    console.error('[WorkspaceContextMenu] export events failed:', err)
    $q.notify({ type: 'negative', message: t('contextMenu.exportEventsError'), position: 'top' })
  } finally {
    dismiss()
  }
}

const settingsStore = useSettingsStore()
const workspaceStore = useWorkspaceStore()

// PR url comes from the cached git-stats (populated when the workspace is
// selected — see workspace store `selectWorkspace`). Falls back to undefined
// when the user right-clicks before ever opening the workspace, in which
// case the menu item is hidden.
const prUrl = computed(() => workspaceStore.gitStatsCache[props.workspace.id]?.prUrl ?? null)

const prSnapshot = computed(() => workspaceStore.prSnapshots[props.workspace.id])

// Dismiss menu items only surface when the corresponding attention reason is
// currently active AND not already dismissed for the latest pr.updatedAt.
const showDismissChangesRequested = computed(() => {
  const snap = prSnapshot.value
  if (!snap || !isChangesRequestedBlocking(snap)) return false
  const dismissed = props.workspace.prChangesDismissedAt
  return !dismissed || snap.updatedAt > dismissed
})
const showDismissCiFailure = computed(() => {
  const snap = prSnapshot.value
  if (!snap || !isCiFailed(snap)) return false
  const dismissed = props.workspace.prCiFailureDismissedAt
  return !dismissed || snap.updatedAt > dismissed
})

// Restore items are the exact inverse of dismiss: the attention reason is
// still active but the badge is currently hidden by a fresh dismiss — let the
// user flip it back to "unseen".
const showRestoreChangesRequested = computed(() => {
  const snap = prSnapshot.value
  if (!snap || !isChangesRequestedBlocking(snap)) return false
  const dismissed = props.workspace.prChangesDismissedAt
  return !!dismissed && snap.updatedAt <= dismissed
})
const showRestoreCiFailure = computed(() => {
  const snap = prSnapshot.value
  if (!snap || !isCiFailed(snap)) return false
  const dismissed = props.workspace.prCiFailureDismissedAt
  return !!dismissed && snap.updatedAt <= dismissed
})

function dismissPrAttention(kind: 'changes-requested' | 'ci-failed') {
  void workspaceStore.dismissPrAttention(props.workspace.id, kind)
}

function restorePrAttention(kind: 'changes-requested' | 'ci-failed') {
  void workspaceStore.restorePrAttention(props.workspace.id, kind)
}
</script>
