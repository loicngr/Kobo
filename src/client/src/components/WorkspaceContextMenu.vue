<script setup lang="ts">
import { useSettingsStore } from 'src/stores/settings'
import type { Workspace } from 'src/stores/workspace'

withDefaults(
  defineProps<{
    workspace: Workspace
    archived?: boolean
  }>(),
  { archived: false },
)

const emit = defineEmits<{
  rename: [ws: Workspace]
  copyPath: [ws: Workspace]
  openEditor: [ws: Workspace]
  runSetup: [ws: Workspace]
  toggleFavorite: [ws: Workspace]
  manageTags: [ws: Workspace]
  archive: [ws: Workspace, event: Event]
  unarchive: [ws: Workspace, event: Event]
  delete: [ws: Workspace, event: Event]
}>()

const settingsStore = useSettingsStore()
</script>

<template>
  <q-menu dark context-menu>
    <q-list dense style="min-width: 180px;">
      <q-item clickable v-close-popup @click="emit('rename', workspace)">
        <q-item-section side><q-icon name="edit" size="xs" /></q-item-section>
        <q-item-section>{{ $t('contextMenu.rename') }}</q-item-section>
      </q-item>
      <q-item clickable v-close-popup @click="emit('copyPath', workspace)">
        <q-item-section side><q-icon name="content_copy" size="xs" /></q-item-section>
        <q-item-section>{{ $t('contextMenu.copyPath') }}</q-item-section>
      </q-item>
      <q-item v-if="settingsStore.global.editorCommand" clickable v-close-popup @click="emit('openEditor', workspace)">
        <q-item-section side><q-icon name="open_in_new" size="xs" /></q-item-section>
        <q-item-section>{{ $t('contextMenu.openEditor') }}</q-item-section>
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
      <q-separator dark />
      <q-item v-if="archived" clickable v-close-popup @click="(e) => emit('unarchive', workspace, e)">
        <q-item-section side><q-icon name="unarchive" size="xs" /></q-item-section>
        <q-item-section>{{ $t('common.unarchive') }}</q-item-section>
      </q-item>
      <q-item v-else clickable v-close-popup @click="(e) => emit('archive', workspace, e)">
        <q-item-section side><q-icon name="archive" size="xs" /></q-item-section>
        <q-item-section>{{ $t('common.archive') }}</q-item-section>
      </q-item>
      <q-item clickable v-close-popup class="text-red-5" @click="(e) => emit('delete', workspace, e)">
        <q-item-section side><q-icon name="delete_outline" size="xs" color="red-5" /></q-item-section>
        <q-item-section>{{ $t('common.delete') }}</q-item-section>
      </q-item>
    </q-list>
  </q-menu>
</template>
