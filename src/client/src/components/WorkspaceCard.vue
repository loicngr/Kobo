<template>
  <div
    data-testid="workspace-card"
    class="wl-item cursor-pointer q-pa-sm q-mx-xs rounded-borders"
    :class="{ 'wl-item--selected': selected, 'wl-item--archived': variant === 'archived' }"
    role="option"
    tabindex="0"
    :aria-selected="selected"
    :aria-label="t('workspaceList.a11y.card', { name: workspace.name, status: statusLabel })"
    :style="[
      { borderLeft: `3px solid ${borderColor}` },
      workspace.favoritedAt ? { borderBottom: '2px solid var(--kobo-warning)' } : {},
    ]"
    @click="emit('select', workspace.id)"
    @keydown.enter.prevent="emit('select', workspace.id)"
    @keydown.space.prevent="emit('select', workspace.id)"
    @contextmenu.prevent
  >
    <WorkspaceContextMenu
      :workspace="workspace"
      :archived="variant === 'archived'"
      @rename="emit('rename', $event)"
      @edit-description="emit('editDescription', $event)"
      @copy-path="emit('copyPath', $event)"
      @open-editor="emit('openEditor', $event)"
      @open-file-manager="emit('openFileManager', $event)"
      @run-setup="emit('runSetup', $event)"
      @toggle-favorite="emit('toggleFavorite', $event)"
      @manage-tags="emit('manageTags', $event)"
      @archive="(ws, ev) => emit('archive', ws, ev)"
      @unarchive="(ws, ev) => emit('unarchive', ws, ev)"
      @purge-worktree="(ws, ev) => emit('purgeWorktree', ws, ev)"
      @delete="(ws, ev) => emit('delete', ws, ev)"
    />
    <div class="col" style="min-width: 0;">
      <div class="row items-center no-wrap q-gutter-xs">
        <WorkspaceDrawerIndicators :workspace="workspace" />
        <div
          class="wl-item-name text-body2 text-kobo-1 ellipsis"
          :style="nameStyle"
        >
          {{ workspace.name }}
          <q-tooltip>{{ workspace.name }}</q-tooltip>
        </div>
      </div>
      <div
        v-if="workspace.agentDescription || workspace.description"
        class="text-caption text-kobo-3 ellipsis q-mt-xs"
        :title="workspace.agentDescription || workspace.description || undefined"
        style="max-width: 100%; font-size: 11px;"
      >
        {{ workspace.agentDescription || workspace.description }}
      </div>
      <AutoLoopChip :workspace="workspace" class="q-mt-xs" />
      <!-- The attention group wants every label; the other groups only want an
           in-flight CI recap. Deliberate, documented in WorkspaceAttentionLabels. -->
      <WorkspaceAttentionLabels :workspace="workspace" :ci-recap-only="variant !== 'attention'" />
      <div v-if="variant === 'running'" class="text-caption q-mt-xs">
        <span class="text-green-4">{{ statusLabel }}</span>
        <span class="q-ml-xs text-kobo-3">&middot; {{ timeAgo(workspace.updatedAt) }}</span>
      </div>
      <div v-else-if="variant === 'idle'" class="wl-item-meta text-caption text-kobo-3">
        {{ timeAgo(workspace.updatedAt) }}
      </div>
      <div v-else-if="variant === 'archived'" class="wl-item-meta text-caption text-kobo-3">
        {{ t('workspaceList.archived') }} {{ timeAgo(workspace.archivedAt!) }}
      </div>
      <div v-if="showProjectChip || workspace.tags.length > 0" class="row q-gutter-xs q-mt-xs">
        <q-chip
          v-if="showProjectChip"
          dense
          size="sm"
          :color="projectColorFor(workspace) ?? 'kobo-hover'"
          :text-color="projectTextColorFor(workspace)"
          :label="projectNameFor(workspace)"
        />
        <q-chip
          v-for="tag in workspace.tags"
          :key="tag"
          dense
          size="sm"
          color="kobo-hover"
          text-color="kobo-1"
          :label="tag"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import AutoLoopChip from 'src/components/AutoLoopChip.vue'
import WorkspaceAttentionLabels from 'src/components/WorkspaceAttentionLabels.vue'
import WorkspaceContextMenu from 'src/components/WorkspaceContextMenu.vue'
import WorkspaceDrawerIndicators from 'src/components/WorkspaceDrawerIndicators.vue'
import type { Workspace } from 'src/stores/workspace'
import { useTimeAgo } from 'src/utils/formatters'
import { projectColorFor, projectNameFor, projectTextColorFor } from 'src/utils/project-color'
import { workspaceStatusKey } from 'src/utils/workspace-status'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  workspace: Workspace
  variant: 'attention' | 'running' | 'idle' | 'archived'
  selected: boolean
  /** Render the project chip — only the flattened groups do, the grouped ones
   *  already carry a project label above the rows. */
  showProjectChip: boolean
  /** Only the attention variant computes its border from the PR snapshot. */
  borderColor: string
}>()

const emit = defineEmits<{
  select: [id: string]
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

const { t } = useI18n()
const { timeAgo } = useTimeAgo()

const statusLabel = computed(() => {
  const key = workspaceStatusKey(props.workspace.status)
  return key ? t(key) : props.workspace.status
})

// The archived variant deliberately drops the unread emphasis: an archived
// workspace has nothing left to read.
const nameStyle = computed(() =>
  props.variant === 'archived'
    ? { maxWidth: '400px' }
    : {
        fontWeight: props.workspace.hasUnread ? 700 : 400,
        opacity: props.workspace.hasUnread ? 1 : 0.75,
        maxWidth: '400px',
      },
)
</script>

<style lang="scss" scoped>
.wl-item {
  background-color: var(--kobo-surface);
  position: relative;
  transition: background-color 0.15s, box-shadow 0.15s;
  margin-bottom: 4px;

  &:last-child { margin-bottom: 0; }
  &:hover { background-color: var(--kobo-hover); }
  &--selected {
    background-color: var(--kobo-hover);
    /* rgba() stays literal (not tokenizable without color-mix(), unsupported on
       the safari14 build target) — this is --kobo-accent's RGB, the AA-corrected
       value from the design-system remediation, not the pre-fix accent. Keep in
       sync with design-tokens.scss if that changes. */
    outline: 1.5px solid rgba(102, 95, 221, 0.95);
    box-shadow: 0 0 0 1px rgba(102, 95, 221, 0.3), 0 2px 8px rgba(102, 95, 221, 0.25);

    &:hover { background-color: var(--kobo-hover); }

    .wl-item-name {
      color: var(--kobo-text) !important;
      opacity: 1 !important;
    }
  }
}

.wl-item-action {
  position: absolute;
  top: 4px;
  right: 4px;
}

.wl-item--archived .wl-item-action {
  opacity: 0;
  transition: opacity 0.15s;
}

.wl-item--archived:hover .wl-item-action {
  opacity: 1;
}

.wl-item-unarchive { right: 28px; }
.wl-item-delete { right: 4px; }

.wl-item--archived {
  opacity: 0.6;
  background-color: var(--kobo-surface-2);

  &:hover { opacity: 0.85; }
  &.wl-item--selected { opacity: 1; }
}
</style>
