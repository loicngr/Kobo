<template>
  <div class="workspace-list row column full-height" data-tour="workspace-list">
    <!-- Header -->
    <div class="row items-center no-wrap q-pl-md q-pr-xs q-py-sm">
      <span class="text-caption text-uppercase text-weight-bold text-grey-6 col ellipsis">
        {{ $t('workspaceList.title') }}
      </span>
      <div class="col items-center justify-end row">
        <q-badge
            v-if="wsStore.connected"
            rounded
            color="positive"
            class="q-ml-xs"
        />
        <q-badge
            v-else
            rounded
            color="negative"
            class="q-ml-xs"
        />
        <q-btn
            flat
            round
            dense
            icon="search"
            class="q-ml-xs"
            size="sm"
            color="grey-5"
            @click="goToSearch"
        >
          <q-tooltip>{{ $t('search.tooltip') }}</q-tooltip>
        </q-btn>
        <q-btn
            flat
            round
            dense
            icon="monitor_heart"
            class="q-ml-xs"
            size="sm"
            color="grey-5"
            data-tour="health"
            @click="goToHealth"
        >
          <q-tooltip>{{ $t('health.tooltip') }}</q-tooltip>
        </q-btn>
        <q-btn
            flat
            round
            dense
            icon="history_edu"
            class="q-ml-xs"
            size="sm"
            color="grey-5"
            data-tour="changelog"
            @click="goToChangelog"
        >
          <q-tooltip>{{ $t('changelog.tooltip') }}</q-tooltip>
        </q-btn>
        <q-btn
            flat
            round
            dense
            icon="settings"
            class="q-ml-xs"
            size="sm"
            color="grey-5"
            data-tour="settings"
            @click="goToSettings"
        />
        <q-btn
            flat
            round
            dense
            icon="add"
            size="sm"
            color="grey-5"
            data-tour="create-workspace"
            @click="goToCreate"
        />
      </div>
    </div>

    <!-- Search -->
    <div class="q-px-md q-pb-sm row items-center no-wrap q-gutter-xs">
      <q-input
        v-model="searchQuery"
        dense
        dark
        :placeholder="$t('common.search')"
        class="wl-search rounded-borders col"
        borderless
        data-tour="search"
      >
        <template #prepend>
          <q-icon name="search" size="xs" color="grey-6" />
        </template>
      </q-input>
      <q-btn
        :icon="favoritesOnly ? 'star' : 'star_outline'"
        :color="favoritesOnly ? 'amber-7' : 'grey-7'"
        flat
        dense
        round
        size="sm"
        @click="favoritesOnly = !favoritesOnly"
      >
        <q-tooltip>{{ $t('workspace.showFavoritesOnly') }}</q-tooltip>
      </q-btn>
      <q-btn
        icon="inventory_2"
        :color="searchArchived ? 'indigo-4' : 'grey-7'"
        flat
        dense
        round
        size="sm"
        @click="searchArchived = !searchArchived"
      >
        <q-tooltip>{{ $t('workspace.searchArchivedToggle') }}</q-tooltip>
      </q-btn>
    </div>

    <q-separator dark />

    <!-- Scrollable groups -->
    <div class="col overflow-auto">
      <!-- Needs Attention -->
      <div v-if="filteredNeedsAttention.length > 0" class="wl-group q-mt-xs">
        <div
          class="wl-group-header row items-center q-px-md q-py-xs cursor-pointer non-selectable"
          @click="attentionExpanded = !attentionExpanded"
        >
          <q-icon
            :name="attentionExpanded ? 'expand_more' : 'chevron_right'"
            size="xs"
            color="red-5"
          />
          <span class="text-caption text-weight-bold q-ml-xs text-red-5">
            {{ $t('workspaceList.needsAttention') }}
          </span>
          <q-badge
            :label="filteredNeedsAttention.length"
            color="red-9"
            text-color="white"
            class="q-ml-auto"
            style="font-size: 10px;"
          />
        </div>

        <div v-show="attentionExpanded">
          <template v-if="!flatten">
            <div v-for="group in groupedNeedsAttention" :key="group.projectPath" class="wl-project-group">
              <div class="wl-project-label q-px-md q-pt-xs">
                <q-icon name="folder" size="12px" :color="group.projectColor ?? 'grey-7'" class="q-mr-xs" />
                <span class="text-caption" :class="group.projectColor ? `text-${group.projectColor}` : 'text-grey-7'">
                  {{ group.projectName }}
                </span>
              </div>
              <div
                v-for="ws in group.workspaces"
                :key="ws.id"
                class="wl-item cursor-pointer q-pa-sm q-mx-xs rounded-borders"
                :class="{ 'wl-item--selected': ws.id === store.selectedWorkspaceId }"
                :style="[
                  { borderLeft: `3px solid ${attentionBorderColor(ws)}` },
                  ws.favoritedAt ? { borderBottom: '2px solid #f59e0b' } : {},
                ]"
                @click="selectWorkspace(ws.id)"
                @contextmenu.prevent
              >
                <WorkspaceContextMenu
                  :workspace="ws"
                  @rename="renameWorkspace"
                  @edit-description="editDescription"
                  @copy-path="copyWorktreePath"
                  @open-editor="openInEditor"
              @open-file-manager="openInFileManager"
                  @run-setup="runSetupScript"
                  @toggle-favorite="onToggleFavorite"
                  @manage-tags="onManageTags"
                  @archive="onArchiveClick"
              @purge-worktree="onPurgeWorktreeClick"
                  @delete="openDeleteDialog"
                />
                <div class="col" style="min-width: 0;">
                  <div class="row items-center no-wrap q-gutter-xs">
                    <WorkspaceDrawerIndicators :workspace="ws" />
                    <div class="wl-item-name text-body2 text-grey-3 ellipsis" :style="{ fontWeight: ws.hasUnread ? 700 : 400, opacity: ws.hasUnread ? 1 : 0.75, maxWidth: '400px' }">
                      {{ ws.name }}
                      <q-tooltip>{{ ws.name }}</q-tooltip>
                    </div>
                  </div>
                  <div
                    v-if="ws.agentDescription || ws.description"
                    class="text-caption text-grey-7 ellipsis q-mt-xs"
                    :title="ws.agentDescription || ws.description"
                    style="max-width: 100%; font-size: 11px;"
                  >
                    {{ ws.agentDescription || ws.description }}
                  </div>
                  <AutoLoopChip :workspace="ws" class="q-mt-xs" />
                  <WorkspaceAttentionLabels :workspace="ws" />
                  <div v-if="ws.tags.length > 0" class="row q-gutter-xs q-mt-xs">
                    <q-chip v-for="tag in ws.tags" :key="tag" dense size="sm" color="grey-8" text-color="grey-3" :label="tag" />
                  </div>
                </div>
              </div>
            </div>
          </template>
          <template v-else>
            <div
              v-for="ws in flatNeedsAttention"
              :key="ws.id"
              class="wl-item cursor-pointer q-pa-sm q-mx-xs rounded-borders"
              :class="{ 'wl-item--selected': ws.id === store.selectedWorkspaceId }"
              :style="[
                { borderLeft: `3px solid ${attentionBorderColor(ws)}` },
                ws.favoritedAt ? { borderBottom: '2px solid #f59e0b' } : {},
              ]"
              @click="selectWorkspace(ws.id)"
              @contextmenu.prevent
            >
              <WorkspaceContextMenu
                :workspace="ws"
                @rename="renameWorkspace"
                @edit-description="editDescription"
                @copy-path="copyWorktreePath"
                @open-editor="openInEditor"
              @open-file-manager="openInFileManager"
                @run-setup="runSetupScript"
                @toggle-favorite="onToggleFavorite"
                @manage-tags="onManageTags"
                @archive="onArchiveClick"
              @purge-worktree="onPurgeWorktreeClick"
                @delete="openDeleteDialog"
              />
              <div class="col" style="min-width: 0;">
                <div class="row items-center no-wrap q-gutter-xs">
                  <WorkspaceDrawerIndicators :workspace="ws" />
                  <div class="wl-item-name text-body2 text-grey-3 ellipsis" :style="{ fontWeight: ws.hasUnread ? 700 : 400, opacity: ws.hasUnread ? 1 : 0.75, maxWidth: '400px' }">
                    {{ ws.name }}
                    <q-tooltip>{{ ws.name }}</q-tooltip>
                  </div>
                </div>
                <div
                  v-if="ws.agentDescription || ws.description"
                  class="text-caption text-grey-7 ellipsis q-mt-xs"
                  :title="ws.agentDescription || ws.description"
                  style="max-width: 100%; font-size: 11px;"
                >
                  {{ ws.agentDescription || ws.description }}
                </div>
                <AutoLoopChip :workspace="ws" class="q-mt-xs" />
                <WorkspaceAttentionLabels :workspace="ws" />
                <div v-if="flatten || ws.tags.length > 0" class="row q-gutter-xs q-mt-xs">
                  <q-chip
                    v-if="flatten"
                    dense
                    size="sm"
                    :color="projectColorFor(ws) ?? 'grey-8'"
                    :text-color="projectTextColorFor(ws)"
                    :label="projectNameFor(ws)"
                  />
                  <q-chip v-for="tag in ws.tags" :key="tag" dense size="sm" color="grey-8" text-color="grey-3" :label="tag" />
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>

      <!-- Running -->
      <div v-if="filteredRunning.length > 0" class="wl-group q-mt-xs">
        <div
          class="wl-group-header row items-center q-px-md q-py-xs cursor-pointer non-selectable"
          @click="runningExpanded = !runningExpanded"
        >
          <q-icon
            :name="runningExpanded ? 'expand_more' : 'chevron_right'"
            size="xs"
            color="green-5"
          />
          <span class="text-caption text-weight-bold q-ml-xs text-green-4">
            {{ $t('workspaceList.running') }}
          </span>
          <q-badge
            :label="filteredRunning.length"
            color="green-9"
            text-color="white"
            class="q-ml-auto"
            style="font-size: 10px;"
          />
        </div>

        <div v-show="runningExpanded">
          <template v-if="!flatten">
            <div v-for="group in groupedRunning" :key="group.projectPath" class="wl-project-group">
              <div class="wl-project-label q-px-md q-pt-xs">
                <q-icon name="folder" size="12px" :color="group.projectColor ?? 'grey-7'" class="q-mr-xs" />
                <span class="text-caption" :class="group.projectColor ? `text-${group.projectColor}` : 'text-grey-7'">
                  {{ group.projectName }}
                </span>
              </div>
              <div
                v-for="ws in group.workspaces"
                :key="ws.id"
                class="wl-item cursor-pointer q-pa-sm q-mx-xs rounded-borders"
                :class="{ 'wl-item--selected': ws.id === store.selectedWorkspaceId }"
                :style="[
                  { borderLeft: '3px solid #4ade80' },
                  ws.favoritedAt ? { borderBottom: '2px solid #f59e0b' } : {},
                ]"
                @click="selectWorkspace(ws.id)"
                @contextmenu.prevent
              >
                <WorkspaceContextMenu
                  :workspace="ws"
                  @rename="renameWorkspace"
                  @edit-description="editDescription"
                  @copy-path="copyWorktreePath"
                  @open-editor="openInEditor"
              @open-file-manager="openInFileManager"
                  @run-setup="runSetupScript"
                  @toggle-favorite="onToggleFavorite"
                  @manage-tags="onManageTags"
                  @archive="onArchiveClick"
              @purge-worktree="onPurgeWorktreeClick"
                  @delete="openDeleteDialog"
                />
                <div class="col" style="min-width: 0;">
                  <div class="row items-center no-wrap q-gutter-xs">
                    <WorkspaceDrawerIndicators :workspace="ws" />
                    <div class="wl-item-name text-body2 text-grey-3 ellipsis" :style="{ fontWeight: ws.hasUnread ? 700 : 400, opacity: ws.hasUnread ? 1 : 0.75, maxWidth: '400px' }">
                      {{ ws.name }}
                      <q-tooltip>{{ ws.name }}</q-tooltip>
                    </div>
                  </div>
                  <div
                    v-if="ws.agentDescription || ws.description"
                    class="text-caption text-grey-7 ellipsis q-mt-xs"
                    :title="ws.agentDescription || ws.description"
                    style="max-width: 100%; font-size: 11px;"
                  >
                    {{ ws.agentDescription || ws.description }}
                  </div>
                  <AutoLoopChip :workspace="ws" class="q-mt-xs" />
                  <div class="text-caption q-mt-xs">
                    <span class="text-green-4">{{ ws.status }}</span>
                    <span class="q-ml-xs text-grey-8">&middot; {{ timeAgo(ws.updatedAt) }}</span>
                  </div>
                  <div v-if="ws.tags.length > 0" class="row q-gutter-xs q-mt-xs">
                    <q-chip v-for="tag in ws.tags" :key="tag" dense size="sm" color="grey-8" text-color="grey-3" :label="tag" />
                  </div>
                </div>
              </div>
            </div>
          </template>
          <template v-else>
            <div
              v-for="ws in flatRunning"
              :key="ws.id"
              class="wl-item cursor-pointer q-pa-sm q-mx-xs rounded-borders"
              :class="{ 'wl-item--selected': ws.id === store.selectedWorkspaceId }"
              :style="[
                { borderLeft: '3px solid #4ade80' },
                ws.favoritedAt ? { borderBottom: '2px solid #f59e0b' } : {},
              ]"
              @click="selectWorkspace(ws.id)"
              @contextmenu.prevent
            >
              <WorkspaceContextMenu
                :workspace="ws"
                @rename="renameWorkspace"
                @edit-description="editDescription"
                @copy-path="copyWorktreePath"
                @open-editor="openInEditor"
              @open-file-manager="openInFileManager"
                @run-setup="runSetupScript"
                @toggle-favorite="onToggleFavorite"
                @manage-tags="onManageTags"
                @archive="onArchiveClick"
              @purge-worktree="onPurgeWorktreeClick"
                @delete="openDeleteDialog"
              />
              <div class="col" style="min-width: 0;">
                <div class="row items-center no-wrap q-gutter-xs">
                  <WorkspaceDrawerIndicators :workspace="ws" />
                  <div class="wl-item-name text-body2 text-grey-3 ellipsis" :style="{ fontWeight: ws.hasUnread ? 700 : 400, opacity: ws.hasUnread ? 1 : 0.75, maxWidth: '400px' }">
                    {{ ws.name }}
                    <q-tooltip>{{ ws.name }}</q-tooltip>
                  </div>
                </div>
                <div
                  v-if="ws.agentDescription || ws.description"
                  class="text-caption text-grey-7 ellipsis q-mt-xs"
                  :title="ws.agentDescription || ws.description"
                  style="max-width: 100%; font-size: 11px;"
                >
                  {{ ws.agentDescription || ws.description }}
                </div>
                <AutoLoopChip :workspace="ws" class="q-mt-xs" />
                <div class="text-caption q-mt-xs">
                  <span class="text-green-4">{{ ws.status }}</span>
                  <span class="q-ml-xs text-grey-8">&middot; {{ timeAgo(ws.updatedAt) }}</span>
                </div>
                <div v-if="flatten || ws.tags.length > 0" class="row q-gutter-xs q-mt-xs">
                  <q-chip
                    v-if="flatten"
                    dense
                    size="sm"
                    :color="projectColorFor(ws) ?? 'grey-8'"
                    :text-color="projectTextColorFor(ws)"
                    :label="projectNameFor(ws)"
                  />
                  <q-chip v-for="tag in ws.tags" :key="tag" dense size="sm" color="grey-8" text-color="grey-3" :label="tag" />
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>

      <!-- Idle -->
      <div v-if="filteredIdle.length > 0" class="wl-group q-mt-xs">
        <div
          class="wl-group-header row items-center q-px-md q-py-xs cursor-pointer non-selectable"
          @click="idleExpanded = !idleExpanded"
        >
          <q-icon
            :name="idleExpanded ? 'expand_more' : 'chevron_right'"
            size="xs"
            color="grey-6"
          />
          <span class="text-caption text-weight-bold q-ml-xs text-grey-6">
            {{ $t('workspaceList.idle') }}
          </span>
          <q-badge
            :label="filteredIdle.length"
            color="grey-8"
            text-color="grey-4"
            class="q-ml-auto"
            style="font-size: 10px;"
          />
        </div>

        <div v-show="idleExpanded">
          <template v-if="!flatten">
            <div v-for="group in groupedIdle" :key="group.projectPath" class="wl-project-group">
              <div class="wl-project-label q-px-md q-pt-xs">
                <q-icon name="folder" size="12px" :color="group.projectColor ?? 'grey-7'" class="q-mr-xs" />
                <span class="text-caption" :class="group.projectColor ? `text-${group.projectColor}` : 'text-grey-7'">
                  {{ group.projectName }}
                </span>
              </div>
              <div
                v-for="ws in group.workspaces"
                :key="ws.id"
                class="wl-item cursor-pointer q-pa-sm q-mx-xs rounded-borders"
                :class="{ 'wl-item--selected': ws.id === store.selectedWorkspaceId }"
                :style="[
                  { borderLeft: '3px solid #666' },
                  ws.favoritedAt ? { borderBottom: '2px solid #f59e0b' } : {},
                ]"
                @click="selectWorkspace(ws.id)"
                @contextmenu.prevent
              >
                <WorkspaceContextMenu
                  :workspace="ws"
                  @rename="renameWorkspace"
                  @edit-description="editDescription"
                  @copy-path="copyWorktreePath"
                  @open-editor="openInEditor"
              @open-file-manager="openInFileManager"
                  @run-setup="runSetupScript"
                  @toggle-favorite="onToggleFavorite"
                  @manage-tags="onManageTags"
                  @archive="onArchiveClick"
              @purge-worktree="onPurgeWorktreeClick"
                  @delete="openDeleteDialog"
                />
                <div class="col" style="min-width: 0;">
                  <div class="row items-center no-wrap q-gutter-xs">
                    <WorkspaceDrawerIndicators :workspace="ws" />
                    <div class="wl-item-name text-body2 text-grey-3 ellipsis" :style="{ fontWeight: ws.hasUnread ? 700 : 400, opacity: ws.hasUnread ? 1 : 0.75, maxWidth: '400px' }">
                      {{ ws.name }}
                      <q-tooltip>{{ ws.name }}</q-tooltip>
                    </div>
                  </div>
                  <div
                    v-if="ws.agentDescription || ws.description"
                    class="text-caption text-grey-7 ellipsis q-mt-xs"
                    :title="ws.agentDescription || ws.description"
                    style="max-width: 100%; font-size: 11px;"
                  >
                    {{ ws.agentDescription || ws.description }}
                  </div>
                  <AutoLoopChip :workspace="ws" class="q-mt-xs" />
                  <div class="wl-item-meta text-caption text-grey-8">
                    {{ timeAgo(ws.updatedAt) }}
                  </div>
                  <div v-if="ws.tags.length > 0" class="row q-gutter-xs q-mt-xs">
                    <q-chip v-for="tag in ws.tags" :key="tag" dense size="sm" color="grey-8" text-color="grey-3" :label="tag" />
                  </div>
                </div>
              </div>
            </div>
          </template>
          <template v-else>
            <div
              v-for="ws in flatIdle"
              :key="ws.id"
              class="wl-item cursor-pointer q-pa-sm q-mx-xs rounded-borders"
              :class="{ 'wl-item--selected': ws.id === store.selectedWorkspaceId }"
              :style="[
                { borderLeft: '3px solid #666' },
                ws.favoritedAt ? { borderBottom: '2px solid #f59e0b' } : {},
              ]"
              @click="selectWorkspace(ws.id)"
              @contextmenu.prevent
            >
              <WorkspaceContextMenu
                :workspace="ws"
                @rename="renameWorkspace"
                @edit-description="editDescription"
                @copy-path="copyWorktreePath"
                @open-editor="openInEditor"
              @open-file-manager="openInFileManager"
                @run-setup="runSetupScript"
                @toggle-favorite="onToggleFavorite"
                @manage-tags="onManageTags"
                @archive="onArchiveClick"
              @purge-worktree="onPurgeWorktreeClick"
                @delete="openDeleteDialog"
              />
              <div class="col" style="min-width: 0;">
                <div class="row items-center no-wrap q-gutter-xs">
                  <WorkspaceDrawerIndicators :workspace="ws" />
                  <div class="wl-item-name text-body2 text-grey-3 ellipsis" :style="{ fontWeight: ws.hasUnread ? 700 : 400, opacity: ws.hasUnread ? 1 : 0.75, maxWidth: '400px' }">
                    {{ ws.name }}
                    <q-tooltip>{{ ws.name }}</q-tooltip>
                  </div>
                </div>
                <div
                  v-if="ws.agentDescription || ws.description"
                  class="text-caption text-grey-7 ellipsis q-mt-xs"
                  :title="ws.agentDescription || ws.description"
                  style="max-width: 100%; font-size: 11px;"
                >
                  {{ ws.agentDescription || ws.description }}
                </div>
                <AutoLoopChip :workspace="ws" class="q-mt-xs" />
                <div class="wl-item-meta text-caption text-grey-8">
                  {{ timeAgo(ws.updatedAt) }}
                </div>
                <div v-if="flatten || ws.tags.length > 0" class="row q-gutter-xs q-mt-xs">
                  <q-chip
                    v-if="flatten"
                    dense
                    size="sm"
                    :color="projectColorFor(ws) ?? 'grey-8'"
                    :text-color="projectTextColorFor(ws)"
                    :label="projectNameFor(ws)"
                  />
                  <q-chip v-for="tag in ws.tags" :key="tag" dense size="sm" color="grey-8" text-color="grey-3" :label="tag" />
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>

      <!-- Archived -->
      <div v-if="filteredArchived.length > 0 || archivedExpanded" class="wl-group q-mt-xs">
        <div
          class="wl-group-header row items-center q-px-md q-py-xs cursor-pointer non-selectable"
          @click="toggleArchived"
        >
          <q-icon
            :name="archivedExpanded || archivedAutoExpanded ? 'expand_more' : 'chevron_right'"
            size="xs"
            color="grey-7"
          />
          <q-icon name="inventory_2" size="xs" color="grey-7" class="q-ml-xs" />
          <span class="text-caption text-weight-bold q-ml-xs text-grey-7">
            {{ $t('workspaceList.archived') }}
          </span>
          <q-badge
            v-if="filteredArchived.length > 0"
            :label="filteredArchived.length"
            color="grey-9"
            text-color="grey-5"
            class="q-ml-auto"
            style="font-size: 10px;"
          />
          <q-btn
            v-if="filteredArchived.length > 0"
            flat
            dense
            round
            size="xs"
            icon="delete_sweep"
            color="grey-7"
            class="q-ml-xs"
            @click.stop="openBulkDeleteArchivedDialog"
          >
            <q-tooltip>{{ $t('workspaceList.deleteArchivedDialog.tooltip') }}</q-tooltip>
          </q-btn>
        </div>

        <div v-show="archivedExpanded || archivedAutoExpanded">
          <div
            v-for="ws in filteredArchived"
            :key="ws.id"
            class="wl-item wl-item--archived cursor-pointer q-pa-sm q-mx-xs rounded-borders"
            :class="{ 'wl-item--selected': ws.id === store.selectedWorkspaceId }"
            :style="[
              { borderLeft: '3px solid #555' },
              ws.favoritedAt ? { borderBottom: '2px solid #f59e0b' } : {},
            ]"
            @click="selectWorkspace(ws.id)"
            @contextmenu.prevent
          >
            <WorkspaceContextMenu
              :workspace="ws"
              archived
              @rename="renameWorkspace"
              @edit-description="editDescription"
              @copy-path="copyWorktreePath"
              @open-editor="openInEditor"
              @open-file-manager="openInFileManager"
              @run-setup="runSetupScript"
              @toggle-favorite="onToggleFavorite"
              @manage-tags="onManageTags"
              @archive="onArchiveClick"
              @purge-worktree="onPurgeWorktreeClick"
              @unarchive="onUnarchiveClick"
              @delete="openDeleteDialog"
            />
            <div class="col" style="min-width: 0;">
              <div class="wl-item-name text-body2 text-grey-5 ellipsis" style="max-width: 400px;">
                {{ ws.name }}
                <q-tooltip>{{ ws.name }}</q-tooltip>
              </div>
              <div
                v-if="ws.agentDescription || ws.description"
                class="text-caption text-grey-7 ellipsis q-mt-xs"
                :title="ws.agentDescription || ws.description"
                style="max-width: 100%; font-size: 11px;"
              >
                {{ ws.agentDescription || ws.description }}
              </div>
              <AutoLoopChip :workspace="ws" class="q-mt-xs" />
              <div class="wl-item-meta text-caption text-grey-8">
                {{ $t('workspaceList.archived') }} {{ timeAgo(ws.archivedAt!) }}
              </div>
              <div v-if="flatten || ws.tags.length > 0" class="row q-gutter-xs q-mt-xs">
                <q-chip
                  v-if="flatten"
                  dense
                  size="sm"
                  :color="projectColorFor(ws) ?? 'grey-8'"
                  :text-color="projectTextColorFor(ws)"
                  :label="projectNameFor(ws)"
                />
                <q-chip v-for="tag in ws.tags" :key="tag" dense size="sm" color="grey-8" text-color="grey-3" :label="tag" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Empty state -->
      <div
        v-if="filteredNeedsAttention.length === 0 && filteredRunning.length === 0 && filteredIdle.length === 0 && filteredArchived.length === 0"
        class="q-pa-lg text-center text-grey-6 text-caption"
      >
        <template v-if="store.loading">{{ $t('common.loading') }}</template>
        <template v-else-if="searchQuery">{{ $t('common.noResults', { query: searchQuery }) }}</template>
        <template v-else>{{ $t('workspaceList.noWorkspaces') }}</template>
      </div>
    </div>

    <q-separator dark />

    <!-- Footer counter -->
    <div class="q-px-md q-py-xs text-caption text-grey-8">
      {{ $t('workspaceList.footer', { count: totalCount }, totalCount) }} &middot; {{ $t('workspaceList.footerRunning', { count: runningCount }) }}
    </div>
  </div>

  <!-- Delete confirmation dialog -->
  <q-dialog v-model="deleteDialog" persistent>
    <q-card class="text-grey-3" style="min-width: 360px; background: #1e1e3a;">
      <q-card-section>
        <div class="text-h6">{{ $t('workspaceList.deleteDialog.title') }}</div>
      </q-card-section>

      <q-card-section class="q-pt-none">
        <div class="text-body2 q-mb-sm text-grey-6">
          {{ deleteTarget?.name }}
        </div>
        <div class="text-caption q-mb-md text-grey-7" style="font-family: monospace;">
          {{ deleteTarget?.workingBranch }}
        </div>

        <div class="column q-gutter-xs">
          <q-checkbox
            v-model="deleteLocalBranch"
            :label="$t('workspaceList.deleteDialog.deleteLocal')"
            dark
            dense
            color="red-5"
          />
          <q-checkbox
            v-model="deleteRemoteBranch"
            :disable="!deleteLocalBranch"
            :label="$t('workspaceList.deleteDialog.deleteRemote')"
            dark
            dense
            color="red-5"
          />
        </div>
        <div v-if="deleteRemoteBranch" class="text-caption q-mt-sm text-red-5">
          {{ $t('workspaceList.deleteDialog.warning') }}
        </div>
      </q-card-section>

      <q-card-actions align="right">
        <q-btn flat :label="$t('common.cancel')" color="grey-5" @click="deleteDialog = false" :disable="deleting" />
        <q-btn
          flat
          :label="$t('common.delete')"
          color="red-5"
          :loading="deleting"
          @click="confirmDelete"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>

  <q-dialog v-model="bulkDeleteArchivedDialog" persistent>
    <q-card class="text-grey-3" style="min-width: 360px; background: #1e1e3a;">
      <q-card-section>
        <div class="text-h6">{{ $t('workspaceList.deleteArchivedDialog.title') }}</div>
      </q-card-section>

      <q-card-section class="q-pt-none">
        <div class="text-body2 q-mb-md text-grey-6">
          {{ $t('workspaceList.deleteArchivedDialog.message', { count: store.archived.length }) }}
        </div>

        <div class="column q-gutter-xs">
          <q-checkbox
            v-model="bulkDeleteLocalBranch"
            :label="$t('workspaceList.deleteDialog.deleteLocal')"
            dark
            dense
            color="red-5"
          />
          <q-checkbox
            v-model="bulkDeleteRemoteBranch"
            :disable="!bulkDeleteLocalBranch"
            :label="$t('workspaceList.deleteDialog.deleteRemote')"
            dark
            dense
            color="red-5"
          />
        </div>
        <div v-if="bulkDeleteRemoteBranch" class="text-caption q-mt-sm text-red-5">
          {{ $t('workspaceList.deleteDialog.warning') }}
        </div>
      </q-card-section>

      <q-card-actions align="right">
        <q-btn
          flat
          :label="$t('common.cancel')"
          color="grey-5"
          :disable="bulkDeleting"
          @click="bulkDeleteArchivedDialog = false"
        />
        <q-btn
          flat
          :label="$t('common.delete')"
          color="red-5"
          :loading="bulkDeleting"
          @click="confirmBulkDeleteArchived"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>

  <ManageTagsDialog
    v-if="tagsDialogWorkspace"
    v-model="tagsDialogOpen"
    :workspace="tagsDialogWorkspace"
  />
</template>

<script setup lang="ts">
import { useQuasar } from 'quasar'
import AutoLoopChip from 'src/components/AutoLoopChip.vue'
import ManageTagsDialog from 'src/components/ManageTagsDialog.vue'
import WorkspaceAttentionLabels from 'src/components/WorkspaceAttentionLabels.vue'
import WorkspaceContextMenu from 'src/components/WorkspaceContextMenu.vue'
import WorkspaceDrawerIndicators from 'src/components/WorkspaceDrawerIndicators.vue'
import { useDevServerStore } from 'src/stores/dev-server'
import { useSettingsStore } from 'src/stores/settings'
import { useWebSocketStore } from 'src/stores/websocket'
import type { Workspace } from 'src/stores/workspace'
import { useWorkspaceStore } from 'src/stores/workspace'
import { useTimeAgo } from 'src/utils/formatters'
import type { ProjectColor } from 'src/utils/project-color'
import { projectColorFor, projectNameFor, projectNameForPath, projectTextColorFor } from 'src/utils/project-color'
import { getAttentionReasons } from 'src/utils/workspace-attention'
import { isBusyStatus } from 'src/utils/workspace-status'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

const { t } = useI18n()
const $q = useQuasar()
const { timeAgo } = useTimeAgo()
const store = useWorkspaceStore()
const wsStore = useWebSocketStore()
const devServerStore = useDevServerStore()
const settingsStore = useSettingsStore()
const router = useRouter()

function attentionBorderColor(ws: Workspace): string {
  const reasons = getAttentionReasons(ws, store.prSnapshots[ws.id])
  return reasons.some((r) => r.color === 'red-5') ? '#ef4444' : '#f59e0b'
}

let workspaceInfoInterval: ReturnType<typeof setInterval> | null = null

const searchQuery = ref('')
const favoritesOnly = ref<boolean>(localStorage.getItem('kobo:favorites-filter') === '1')
watch(favoritesOnly, (v) => localStorage.setItem('kobo:favorites-filter', v ? '1' : '0'))

// When ON and a search query is active, the archived section is filtered by
// the same substring match as the live groups and auto-expands to surface
// matches. When OFF (default), archived is hidden behind its collapsed
// header regardless of the query — preserves the prior behaviour.
const searchArchived = ref<boolean>(localStorage.getItem('kobo:search-archived') === '1')
watch(searchArchived, (v) => localStorage.setItem('kobo:search-archived', v ? '1' : '0'))

const tagsDialogOpen = ref(false)
const tagsDialogWorkspace = ref<Workspace | null>(null)
function onManageTags(ws: Workspace) {
  tagsDialogWorkspace.value = ws
  tagsDialogOpen.value = true
}

interface ProjectGroup {
  projectPath: string
  projectName: string
  projectColor: ProjectColor | null
  workspaces: Workspace[]
}

function groupByProject(workspaces: Workspace[]): ProjectGroup[] {
  const groups = new Map<string, Workspace[]>()
  for (const ws of workspaces) {
    const key = ws.projectPath
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(ws)
  }
  return [...groups.entries()].map(([path, wsList]) => ({
    projectPath: path,
    projectName: projectNameForPath(path),
    projectColor: settingsStore.getProjectByPath(path)?.color ?? null,
    workspaces: wsList,
  }))
}

const filteredNeedsAttention = computed(() =>
  store.needsAttention
    .filter((w) => w.name.toLowerCase().includes(searchQuery.value.toLowerCase()))
    .filter((w) => !favoritesOnly.value || w.favoritedAt !== null),
)

const filteredRunning = computed(() =>
  store.running
    .filter((w) => w.name.toLowerCase().includes(searchQuery.value.toLowerCase()))
    .filter((w) => !favoritesOnly.value || w.favoritedAt !== null),
)

const filteredIdle = computed(() =>
  store.idle
    .filter((w) => w.name.toLowerCase().includes(searchQuery.value.toLowerCase()))
    .filter((w) => !favoritesOnly.value || w.favoritedAt !== null),
)

const groupedNeedsAttention = computed(() => groupByProject(filteredNeedsAttention.value))
const groupedRunning = computed(() => groupByProject(filteredRunning.value))
const groupedIdle = computed(() => groupByProject(filteredIdle.value))

const flatten = computed(() => settingsStore.global.flattenWorkspaceList ?? false)

// Flat lists must keep the source order (`updated_at DESC` from the API), NOT
// the project-grouped order. Deriving these from `groupedX` would re-sort by
// project — making "flat list" still look grouped, just without the headers.
const flatNeedsAttention = computed(() => filteredNeedsAttention.value)
const flatRunning = computed(() => filteredRunning.value)
const flatIdle = computed(() => filteredIdle.value)

// Archived list filtered by the search query when `searchArchived` is ON,
// and by `favoritesOnly` whenever it's ON. With both toggles OFF and an
// empty query, returns the full archived list (current default behaviour).
const filteredArchived = computed(() => {
  const q = searchQuery.value.toLowerCase()
  return store.archived
    .filter((w) => !searchArchived.value || q.length === 0 || w.name.toLowerCase().includes(q))
    .filter((w) => !favoritesOnly.value || w.favoritedAt !== null)
})

// Auto-expand the archived section when the user toggles `searchArchived`
// ON and types a query that matches archived workspaces — surfaces matches
// without a manual click. Empty query or zero matches → no auto-expand
// (header stays collapsed unless the user clicks it).
const archivedAutoExpanded = computed(
  () => searchArchived.value && searchQuery.value.length > 0 && filteredArchived.value.length > 0,
)

const totalCount = computed(() => store.workspaces.length)
const runningCount = computed(() => store.running.length)

const attentionExpanded = ref(true)
const runningExpanded = ref(true)
const idleExpanded = ref(true)
const archivedExpanded = ref(false)

async function toggleArchived() {
  archivedExpanded.value = !archivedExpanded.value
  if (archivedExpanded.value && !store.archivedLoaded) {
    await store.fetchArchivedWorkspaces()
  }
}

// Delete dialog state
const deleteDialog = ref(false)
const deleteTarget = ref<Workspace | null>(null)
const deleteLocalBranch = ref(false)
const deleteRemoteBranch = ref(false)
const deleting = ref(false)

const bulkDeleteArchivedDialog = ref(false)
const bulkDeleteLocalBranch = ref(false)
const bulkDeleteRemoteBranch = ref(false)
const bulkDeleting = ref(false)

function openDeleteDialog(ws: Workspace, event: Event) {
  event.stopPropagation()
  deleteTarget.value = ws
  deleteLocalBranch.value = true
  deleteRemoteBranch.value = false
  deleteDialog.value = true
}

async function confirmDelete() {
  if (!deleteTarget.value) return
  const deletedId = deleteTarget.value.id
  deleting.value = true
  try {
    const { warnings } = await store.deleteWorkspace(deletedId, {
      deleteLocalBranch: deleteLocalBranch.value,
      deleteRemoteBranch: deleteRemoteBranch.value,
    })
    wsStore.unsubscribe(deletedId)
    deleteDialog.value = false
    // If we were viewing this workspace, navigate away
    if (store.selectedWorkspaceId === null) {
      router.push({ name: 'workspace' })
    }

    // Backend succeeded on the DB side but a side-effect (worktree / branch)
    // failed — typically Docker left root-owned files the git remove couldn't
    // touch. Show a persistent notification per warning with the command to
    // copy, so the user can recover in one paste without digging in the logs.
    for (const message of warnings) {
      $q.notify({
        type: 'warning',
        message,
        position: 'top',
        timeout: 0, // sticky until user dismisses
        multiLine: true,
        classes: 'workspace-delete-warning',
        actions: [
          {
            icon: 'content_copy',
            color: 'white',
            round: true,
            handler: () => {
              void navigator.clipboard.writeText(message)
            },
          },
          { label: 'OK', color: 'white', handler: () => undefined },
        ],
      })
    }
  } catch (err) {
    console.error('Delete failed:', err)
  } finally {
    deleting.value = false
  }
}

function openBulkDeleteArchivedDialog() {
  // The button is only rendered when filteredArchived is non-empty, so the
  // archived list is already loaded here — no extra fetch needed.
  bulkDeleteLocalBranch.value = false
  bulkDeleteRemoteBranch.value = false
  bulkDeleteArchivedDialog.value = true
}

async function confirmBulkDeleteArchived() {
  bulkDeleting.value = true
  try {
    const { warnings, ids } = await store.deleteAllArchived({
      deleteLocalBranch: bulkDeleteLocalBranch.value,
      deleteRemoteBranch: bulkDeleteRemoteBranch.value,
    })
    for (const id of ids) wsStore.unsubscribe(id)
    bulkDeleteArchivedDialog.value = false
    // If we were viewing one of the deleted workspaces, navigate away.
    if (store.selectedWorkspaceId === null) {
      router.push({ name: 'workspace' })
    }

    // Same recovery-toast pattern as single delete: a side-effect (worktree /
    // branch) may have failed even though the DB rows are gone.
    for (const message of warnings) {
      $q.notify({
        type: 'warning',
        message,
        position: 'top',
        timeout: 0, // sticky until user dismisses
        multiLine: true,
        classes: 'workspace-delete-warning',
        actions: [
          {
            icon: 'content_copy',
            color: 'white',
            round: true,
            handler: () => {
              void navigator.clipboard.writeText(message)
            },
          },
          { label: 'OK', color: 'white', handler: () => undefined },
        ],
      })
    }
  } catch (err) {
    console.error('Bulk delete archived failed:', err)
  } finally {
    bulkDeleting.value = false
  }
}

async function onArchiveClick(ws: Workspace, event: Event) {
  event.stopPropagation()
  try {
    await store.archiveWorkspace(ws.id)
    // store.archiveWorkspace already cleared selectedWorkspaceId if it matched ws.id
    if (store.selectedWorkspaceId === null) {
      router.push({ name: 'workspace' })
    }
    // Note: we do NOT call wsStore.unsubscribe(ws.id). The server-side
    // subscription is kept so that if the user unarchives from another tab,
    // this tab receives the event and refetches.
  } catch (err) {
    console.error('Archive failed:', err)
  }
}

function onPurgeWorktreeClick(ws: Workspace, event: Event) {
  event.stopPropagation()
  $q.dialog({
    title: t('contextMenu.purgeWorktreeDialogTitle'),
    message: t('contextMenu.purgeWorktreeDialogMessage', { name: ws.name }),
    cancel: { flat: true, label: t('common.cancel'), color: 'grey-5' },
    ok: { unelevated: true, label: t('contextMenu.purgeWorktreeDialogConfirm'), color: 'orange-7' },
    persistent: true,
    dark: true,
  }).onOk(async () => {
    const result = await store.purgeWorktree(ws.id)
    if (!result.ok) {
      $q.notify({ type: 'negative', message: result.error, position: 'top', timeout: 6000 })
      return
    }
    if (result.warnings.length === 0) {
      $q.notify({ type: 'positive', message: t('contextMenu.purgeWorktreeSuccess'), position: 'top' })
    } else {
      // Sticky toasts for warnings (typically Docker permission issues) —
      // same pattern as delete, so the user can copy the recovery command.
      for (const message of result.warnings) {
        $q.notify({
          type: 'warning',
          message,
          position: 'top',
          timeout: 0,
          multiLine: true,
          classes: 'workspace-delete-warning',
          actions: [
            {
              icon: 'content_copy',
              color: 'white',
              round: true,
              handler: () => {
                void navigator.clipboard.writeText(message)
              },
            },
            { label: 'OK', color: 'white', handler: () => undefined },
          ],
        })
      }
    }
    if (store.selectedWorkspaceId === null) {
      router.push({ name: 'workspace' })
    }
  })
}

async function onUnarchiveClick(ws: Workspace, event: Event) {
  event.stopPropagation()
  try {
    await store.unarchiveWorkspace(ws.id)
    // Re-fetch dev-server status for the just-restored workspace.
    // WebSocket subscription is already in place (never removed on archive).
    const project = settingsStore.getProjectByPath(ws.projectPath)
    if (project?.devServer?.startCommand) {
      devServerStore.fetchStatus(ws.id)
    }
  } catch (err) {
    console.error('Unarchive failed:', err)
    const code = (err as { code?: string })?.code
    if (code === 'worktree-purged') {
      $q.notify({
        type: 'warning',
        message: t('workspaceList.unarchiveBlockedPurged'),
        position: 'top',
        timeout: 6000,
        multiLine: true,
      })
    }
  }
}

function selectWorkspace(id: string) {
  store.selectWorkspace(id)
  router.push({ name: 'workspace', params: { id } })
}

function copyWorktreePath(ws: Workspace) {
  navigator.clipboard.writeText(ws.worktreePath).catch(() => {})
}

function renameWorkspace(ws: Workspace) {
  $q.dialog({
    title: t('contextMenu.rename'),
    dark: true,
    prompt: {
      model: ws.name,
      isValid: (val: string) => val.trim().length > 0,
      type: 'text',
    },
    cancel: { flat: true, label: t('common.cancel'), color: 'grey-5' },
    ok: { unelevated: true, label: t('common.save'), color: 'indigo-6' },
  }).onOk(async (name: string) => {
    const trimmed = name.trim()
    if (!trimmed || trimmed === ws.name) return
    try {
      await store.renameWorkspace(ws.id, trimmed)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
    }
  })
}

function editDescription(ws: Workspace) {
  $q.dialog({
    title: t('contextMenu.editDescription'),
    message: t('workspace.descriptionDialogHint'),
    dark: true,
    prompt: {
      model: ws.description ?? '',
      isValid: (val: string) => val.length <= 200,
      type: 'textarea',
    },
    cancel: { flat: true, label: t('common.cancel'), color: 'grey-5' },
    ok: { unelevated: true, label: t('common.save'), color: 'indigo-6' },
  }).onOk(async (description: string) => {
    const trimmed = description.trim()
    const next = trimmed.length > 0 ? trimmed : null
    if (next === (ws.description ?? null)) return
    try {
      await store.updateWorkspaceDescription(ws.id, next)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
    }
  })
}

async function openInEditor(ws: Workspace) {
  try {
    const res = await fetch(`/api/workspaces/${ws.id}/open-editor`, { method: 'POST' })
    if (!res.ok) {
      const data = await res.json()
      console.error('[workspace-list] open-editor failed:', data.error)
    }
  } catch (err) {
    console.error('[workspace-list] open-editor failed:', err)
  }
}

async function openInFileManager(ws: Workspace) {
  try {
    const res = await fetch(`/api/workspaces/${ws.id}/open-file-manager`, { method: 'POST' })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      $q.notify({
        type: 'negative',
        message: data.error ?? t('tools.openFileManagerFailed'),
        position: 'top',
        timeout: 6000,
      })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : t('tools.openFileManagerFailed')
    $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
  }
}

function onToggleFavorite(ws: Workspace) {
  void store.toggleFavorite(ws.id).catch((err) => {
    $q.notify({ type: 'negative', message: String(err), position: 'top', timeout: 4000 })
  })
}

function runSetupScript(ws: Workspace) {
  // Guard: never run while the agent is busy — would race with the agent's work.
  if (isBusyStatus(ws.status)) {
    $q.notify({
      type: 'warning',
      message: t('tools.runSetupScriptBusy'),
      position: 'top',
      timeout: 4000,
    })
    return
  }
  $q.dialog({
    title: t('tools.runSetupScript'),
    message: t('tools.runSetupScriptConfirm'),
    cancel: true,
    persistent: true,
    dark: true,
  }).onOk(async () => {
    try {
      await fetch(`/api/workspaces/${ws.id}/run-setup-script`, { method: 'POST' })
    } catch (err) {
      console.error('[workspace-list] run-setup-script failed:', err)
    }
  })
}

function goToCreate() {
  router.push({ name: 'create' })
}

function goToSettings() {
  router.push({ name: 'settings' })
}

function goToSearch() {
  router.push({ name: 'search' })
}

function goToHealth() {
  router.push({ name: 'health' })
}

function goToChangelog() {
  router.push({ name: 'changelog' })
}

onMounted(async () => {
  await store.fetchWorkspaces()
  // Silently fetch archived workspaces so the Archived group header renders
  // if any exist — the group stays collapsed by default.
  await store.fetchArchivedWorkspaces()
  // Batch PR-snapshot from pr-watcher cache (free — no gh calls).
  // Drives the small PR indicator in the drawer. Refreshed on gitRefreshTrigger
  // bumps (see store.triggerGitRefresh).
  void store.fetchPrSnapshots()
  void store.fetchAutoLoopStates()
  await settingsStore.fetchSettings()
  // Subscribe to ALL workspaces so events are received even when not viewing them
  for (const ws of store.workspaces) {
    wsStore.subscribe(ws.id)
    const project = settingsStore.getProjectByPath(ws.projectPath)
    if (project?.devServer?.startCommand) {
      devServerStore.fetchStatus(ws.id)
    }
  }
  // Keep every non-archived workspace ≤30s fresh (status + PR + git stats)
  // by polling the server-cached bulk endpoint.
  workspaceInfoInterval = setInterval(() => {
    void store.fetchWorkspacesInfo()
  }, 30_000)
})

onBeforeUnmount(() => {
  if (workspaceInfoInterval) {
    clearInterval(workspaceInfoInterval)
    workspaceInfoInterval = null
  }
})
</script>

<style lang="scss" scoped>
.workspace-list {
  background-color: #16162a;
  overflow-x: hidden;
}

.wl-search {
  background-color: #222244;
  padding: 0 8px;

  :deep(.q-field__control) {
    height: 32px;
  }
  :deep(input) {
    color: #ccc;
    font-size: 12px;
  }
}

// wl-group: margin-top moved to template (q-mt-xs)

.wl-group-header {
  &:hover {
    background-color: rgba(255, 255, 255, 0.03);
  }
}

.wl-project-group {
  & + .wl-project-group {
    margin-top: 6px;
  }
}

.wl-project-label {
  display: flex;
  align-items: center;
  padding-bottom: 2px;
  font-size: 11px;
}

.wl-item {
  background-color: #222244;
  position: relative;
  transition: background-color 0.15s, box-shadow 0.15s;
  margin-bottom: 4px;

  &:last-child { margin-bottom: 0; }
  &:hover { background-color: #2a2a4a; }
  &--selected {
    background-color: #393969;
    outline: 1.5px solid rgba(108, 99, 255, 0.95);
    box-shadow: 0 0 0 1px rgba(108, 99, 255, 0.3), 0 2px 8px rgba(108, 99, 255, 0.25);

    &:hover { background-color: #41417a; }

    .wl-item-name {
      color: #ffffff !important;
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
  background-color: #1a1a30;

  &:hover { opacity: 0.85; }
  &.wl-item--selected { opacity: 1; }
}

</style>
