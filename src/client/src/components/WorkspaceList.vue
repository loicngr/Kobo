<template>
  <div class="workspace-list row column full-height" data-tour="workspace-list">
    <!-- Header -->
    <div class="row items-center no-wrap q-pl-md q-pr-xs q-py-sm">
      <span class="text-caption text-uppercase text-weight-bold text-kobo-3 col ellipsis">
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
            color="kobo-2"
            :aria-label="$t('search.tooltip')"
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
            color="kobo-2"
            data-tour="health"
            :aria-label="$t('health.tooltip')"
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
            color="kobo-2"
            data-tour="changelog"
            :aria-label="$t('changelog.tooltip')"
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
            color="kobo-2"
            data-tour="settings"
            :aria-label="$t('settings.title')"
            @click="goToSettings"
        >
          <q-tooltip>{{ $t('settings.title') }}</q-tooltip>
        </q-btn>
        <q-btn
            flat
            round
            dense
            icon="add"
            size="sm"
            color="kobo-2"
            data-tour="create-workspace"
            :aria-label="$t('createPage.title')"
            @click="goToCreate"
        >
          <q-tooltip>{{ $t('createPage.title') }}</q-tooltip>
        </q-btn>
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
          <q-icon name="search" size="xs" color="kobo-3" />
        </template>
      </q-input>
      <q-btn
        :icon="favoritesOnly ? 'star' : 'star_outline'"
        :color="favoritesOnly ? 'amber-7' : 'kobo-3'"
        flat
        dense
        round
        size="sm"
        :aria-label="$t('workspace.showFavoritesOnly')"
        :aria-pressed="favoritesOnly"
        @click="favoritesOnly = !favoritesOnly"
      >
        <q-tooltip>{{ $t('workspace.showFavoritesOnly') }}</q-tooltip>
      </q-btn>
      <q-btn
        icon="inventory_2"
        :color="searchArchived ? 'primary' : 'kobo-3'"
        flat
        dense
        round
        size="sm"
        :aria-label="$t('workspace.searchArchivedToggle')"
        :aria-pressed="searchArchived"
        @click="searchArchived = !searchArchived"
      >
        <q-tooltip>{{ $t('workspace.searchArchivedToggle') }}</q-tooltip>
      </q-btn>
    </div>

    <q-separator dark />

    <!-- Scrollable groups -->
    <div
      class="col overflow-auto"
      role="listbox"
      :aria-label="$t('workspaceList.a11y.list')"
      @keydown.down.prevent="moveFocus(1)"
      @keydown.up.prevent="moveFocus(-1)"
    >
      <!-- Needs Attention -->
      <div v-if="filteredNeedsAttention.length > 0" class="wl-group q-mt-xs">
        <div
          class="wl-group-header row items-center q-px-md q-py-xs cursor-pointer non-selectable"
          role="group"
          tabindex="0"
          :aria-expanded="attentionExpanded"
          aria-labelledby="wl-group-label-attention wl-group-count-attention"
          @click="toggleAttention"
          @keydown.enter.prevent="toggleAttention"
          @keydown.space.prevent="toggleAttention"
        >
          <q-icon
            :name="attentionExpanded ? 'expand_more' : 'chevron_right'"
            size="xs"
            color="red-5"
          />
          <span id="wl-group-label-attention" class="text-caption text-weight-bold q-ml-xs text-red-5">
            {{ $t('workspaceList.needsAttention') }}
          </span>
          <q-badge
            id="wl-group-count-attention"
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
                <q-icon name="folder" size="12px" :color="group.projectColor ?? 'kobo-3'" class="q-mr-xs" />
                <span class="text-caption" :class="group.projectColor ? `text-${group.projectColor}` : 'text-kobo-3'">
                  {{ group.projectName }}
                </span>
              </div>
              <WorkspaceCard
                v-for="ws in group.workspaces"
                :key="ws.id"
                :workspace="ws"
                variant="attention"
                :selected="ws.id === store.selectedWorkspaceId"
                :show-project-chip="false"
                :border-color="attentionBorderColor(ws)"
                @select="selectWorkspace"
                @rename="renameWorkspace"
                @edit-description="editDescription"
                @copy-path="copyWorktreePath"
                @open-editor="openInEditor"
                @open-file-manager="openInFileManager"
                @run-setup="runSetupScript"
                @toggle-favorite="onToggleFavorite"
                @manage-tags="onManageTags"
                @archive="onArchiveClick"
                @unarchive="onUnarchiveClick"
                @purge-worktree="onPurgeWorktreeClick"
                @delete="openDeleteDialog"
              />
            </div>
          </template>
          <template v-else>
            <WorkspaceCard
              v-for="ws in flatNeedsAttention"
              :key="ws.id"
              :workspace="ws"
              variant="attention"
              :selected="ws.id === store.selectedWorkspaceId"
              :show-project-chip="flatten"
              :border-color="attentionBorderColor(ws)"
              @select="selectWorkspace"
              @rename="renameWorkspace"
              @edit-description="editDescription"
              @copy-path="copyWorktreePath"
              @open-editor="openInEditor"
              @open-file-manager="openInFileManager"
              @run-setup="runSetupScript"
              @toggle-favorite="onToggleFavorite"
              @manage-tags="onManageTags"
              @archive="onArchiveClick"
              @unarchive="onUnarchiveClick"
              @purge-worktree="onPurgeWorktreeClick"
              @delete="openDeleteDialog"
            />
          </template>
        </div>
      </div>

      <!-- Running -->
      <div v-if="filteredRunning.length > 0" class="wl-group q-mt-xs">
        <div
          class="wl-group-header row items-center q-px-md q-py-xs cursor-pointer non-selectable"
          role="group"
          tabindex="0"
          :aria-expanded="runningExpanded"
          aria-labelledby="wl-group-label-running wl-group-count-running"
          @click="toggleRunning"
          @keydown.enter.prevent="toggleRunning"
          @keydown.space.prevent="toggleRunning"
        >
          <q-icon
            :name="runningExpanded ? 'expand_more' : 'chevron_right'"
            size="xs"
            color="green-5"
          />
          <span id="wl-group-label-running" class="text-caption text-weight-bold q-ml-xs text-green-4">
            {{ $t('workspaceList.running') }}
          </span>
          <q-badge
            id="wl-group-count-running"
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
                <q-icon name="folder" size="12px" :color="group.projectColor ?? 'kobo-3'" class="q-mr-xs" />
                <span class="text-caption" :class="group.projectColor ? `text-${group.projectColor}` : 'text-kobo-3'">
                  {{ group.projectName }}
                </span>
              </div>
              <WorkspaceCard
                v-for="ws in group.workspaces"
                :key="ws.id"
                :workspace="ws"
                variant="running"
                :selected="ws.id === store.selectedWorkspaceId"
                :show-project-chip="false"
                border-color="var(--kobo-success)"
                @select="selectWorkspace"
                @rename="renameWorkspace"
                @edit-description="editDescription"
                @copy-path="copyWorktreePath"
                @open-editor="openInEditor"
                @open-file-manager="openInFileManager"
                @run-setup="runSetupScript"
                @toggle-favorite="onToggleFavorite"
                @manage-tags="onManageTags"
                @archive="onArchiveClick"
                @unarchive="onUnarchiveClick"
                @purge-worktree="onPurgeWorktreeClick"
                @delete="openDeleteDialog"
              />
            </div>
          </template>
          <template v-else>
            <WorkspaceCard
              v-for="ws in flatRunning"
              :key="ws.id"
              :workspace="ws"
              variant="running"
              :selected="ws.id === store.selectedWorkspaceId"
              :show-project-chip="flatten"
              border-color="var(--kobo-success)"
              @select="selectWorkspace"
              @rename="renameWorkspace"
              @edit-description="editDescription"
              @copy-path="copyWorktreePath"
              @open-editor="openInEditor"
              @open-file-manager="openInFileManager"
              @run-setup="runSetupScript"
              @toggle-favorite="onToggleFavorite"
              @manage-tags="onManageTags"
              @archive="onArchiveClick"
              @unarchive="onUnarchiveClick"
              @purge-worktree="onPurgeWorktreeClick"
              @delete="openDeleteDialog"
            />
          </template>
        </div>
      </div>

      <!-- Idle -->
      <div v-if="filteredIdle.length > 0" class="wl-group q-mt-xs">
        <div
          class="wl-group-header row items-center q-px-md q-py-xs cursor-pointer non-selectable"
          role="group"
          tabindex="0"
          :aria-expanded="idleExpanded"
          aria-labelledby="wl-group-label-idle wl-group-count-idle"
          @click="toggleIdle"
          @keydown.enter.prevent="toggleIdle"
          @keydown.space.prevent="toggleIdle"
        >
          <q-icon
            :name="idleExpanded ? 'expand_more' : 'chevron_right'"
            size="xs"
            color="kobo-3"
          />
          <span id="wl-group-label-idle" class="text-caption text-weight-bold q-ml-xs text-kobo-3">
            {{ $t('workspaceList.idle') }}
          </span>
          <q-badge
            id="wl-group-count-idle"
            :label="filteredIdle.length"
            color="kobo-hover"
            text-color="kobo-2"
            class="q-ml-auto"
            style="font-size: 10px;"
          />
        </div>

        <div v-show="idleExpanded">
          <template v-if="!flatten">
            <div v-for="group in groupedIdle" :key="group.projectPath" class="wl-project-group">
              <div class="wl-project-label q-px-md q-pt-xs">
                <q-icon name="folder" size="12px" :color="group.projectColor ?? 'kobo-3'" class="q-mr-xs" />
                <span class="text-caption" :class="group.projectColor ? `text-${group.projectColor}` : 'text-kobo-3'">
                  {{ group.projectName }}
                </span>
              </div>
              <WorkspaceCard
                v-for="ws in group.workspaces"
                :key="ws.id"
                :workspace="ws"
                variant="idle"
                :selected="ws.id === store.selectedWorkspaceId"
                :show-project-chip="false"
                border-color="var(--kobo-border-strong)"
                @select="selectWorkspace"
                @rename="renameWorkspace"
                @edit-description="editDescription"
                @copy-path="copyWorktreePath"
                @open-editor="openInEditor"
                @open-file-manager="openInFileManager"
                @run-setup="runSetupScript"
                @toggle-favorite="onToggleFavorite"
                @manage-tags="onManageTags"
                @archive="onArchiveClick"
                @unarchive="onUnarchiveClick"
                @purge-worktree="onPurgeWorktreeClick"
                @delete="openDeleteDialog"
              />
            </div>
          </template>
          <template v-else>
            <WorkspaceCard
              v-for="ws in flatIdle"
              :key="ws.id"
              :workspace="ws"
              variant="idle"
              :selected="ws.id === store.selectedWorkspaceId"
              :show-project-chip="flatten"
              border-color="var(--kobo-border-strong)"
              @select="selectWorkspace"
              @rename="renameWorkspace"
              @edit-description="editDescription"
              @copy-path="copyWorktreePath"
              @open-editor="openInEditor"
              @open-file-manager="openInFileManager"
              @run-setup="runSetupScript"
              @toggle-favorite="onToggleFavorite"
              @manage-tags="onManageTags"
              @archive="onArchiveClick"
              @unarchive="onUnarchiveClick"
              @purge-worktree="onPurgeWorktreeClick"
              @delete="openDeleteDialog"
            />
          </template>
        </div>
      </div>

      <!-- Archived -->
      <div v-if="filteredArchived.length > 0 || archivedExpanded" class="wl-group q-mt-xs">
        <div
          class="wl-group-header row items-center q-px-md q-py-xs cursor-pointer non-selectable"
          role="group"
          tabindex="0"
          :aria-expanded="archivedExpanded || archivedAutoExpanded"
          aria-labelledby="wl-group-label-archived wl-group-count-archived"
          @click="toggleArchived"
          @keydown.enter.prevent="toggleArchived"
          @keydown.space.prevent="toggleArchived"
        >
          <q-icon
            :name="archivedExpanded || archivedAutoExpanded ? 'expand_more' : 'chevron_right'"
            size="xs"
            color="kobo-3"
          />
          <q-icon name="inventory_2" size="xs" color="kobo-3" class="q-ml-xs" />
          <span id="wl-group-label-archived" class="text-caption text-weight-bold q-ml-xs text-kobo-3">
            {{ $t('workspaceList.archived') }}
          </span>
          <q-badge
            v-if="filteredArchived.length > 0"
            id="wl-group-count-archived"
            :label="filteredArchived.length"
            color="kobo-surface-2"
            text-color="kobo-2"
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
            color="kobo-3"
            class="q-ml-xs"
            @click.stop="openBulkDeleteArchivedDialog"
          >
            <q-tooltip>{{ $t('workspaceList.deleteArchivedDialog.tooltip') }}</q-tooltip>
          </q-btn>
        </div>

        <div v-show="archivedExpanded || archivedAutoExpanded">
          <WorkspaceCard
            v-for="ws in filteredArchived"
            :key="ws.id"
            :workspace="ws"
            variant="archived"
            :selected="ws.id === store.selectedWorkspaceId"
            :show-project-chip="flatten"
            border-color="var(--kobo-border)"
            @select="selectWorkspace"
            @rename="renameWorkspace"
            @edit-description="editDescription"
            @copy-path="copyWorktreePath"
            @open-editor="openInEditor"
            @open-file-manager="openInFileManager"
            @run-setup="runSetupScript"
            @toggle-favorite="onToggleFavorite"
            @manage-tags="onManageTags"
            @archive="onArchiveClick"
            @unarchive="onUnarchiveClick"
            @purge-worktree="onPurgeWorktreeClick"
            @delete="openDeleteDialog"
          />
        </div>
      </div>

      <!-- Failed load — NOT the same thing as an empty account. -->
      <div v-if="store.listLoadError" class="q-pa-lg text-center">
        <q-icon name="cloud_off" size="28px" class="text-negative" />
        <div class="text-caption text-negative q-mt-sm">{{ $t('workspaceList.loadFailed') }}</div>
        <div class="text-caption text-kobo-3 q-mt-xs">{{ store.listLoadError }}</div>
        <div class="text-caption text-kobo-3 q-mt-xs">{{ $t('workspaceList.loadFailedHint') }}</div>
        <q-btn
          dense
          flat
          no-caps
          class="q-mt-sm"
          icon="refresh"
          :label="$t('common.retry')"
          @click="store.retryLoadWorkspaces()"
        />
      </div>

      <!-- Empty state -->
      <div
        v-else-if="filteredNeedsAttention.length === 0 && filteredRunning.length === 0 && filteredIdle.length === 0 && filteredArchived.length === 0"
        class="q-pa-lg text-center text-kobo-3 text-caption"
      >
        <template v-if="store.loading">{{ $t('common.loading') }}</template>
        <template v-else-if="searchQuery">{{ $t('common.noResults', { query: searchQuery }) }}</template>
        <template v-else>{{ $t('workspaceList.noWorkspaces') }}</template>
      </div>
    </div>

    <q-separator dark />

    <!-- Footer counter -->
    <div class="q-px-md q-py-xs text-caption text-kobo-3">
      {{ $t('workspaceList.footer', { count: totalCount }, totalCount) }} &middot; {{ $t('workspaceList.footerRunning', { count: runningCount }) }}
    </div>
  </div>

  <!-- Delete confirmation dialog -->
  <q-dialog v-model="deleteDialog" persistent>
    <q-card class="text-kobo-1" style="min-width: 360px; background: var(--kobo-surface);">
      <q-card-section>
        <div class="text-h6">{{ $t('workspaceList.deleteDialog.title') }}</div>
      </q-card-section>

      <q-card-section class="q-pt-none">
        <div class="text-body2 q-mb-sm text-kobo-3">
          {{ deleteTarget?.name }}
        </div>
        <div class="text-caption q-mb-md text-kobo-3" style="font-family: monospace;">
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
        <q-btn flat :label="$t('common.cancel')" color="kobo-2" @click="deleteDialog = false" :disable="deleting" />
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
    <q-card class="text-kobo-1" style="min-width: 360px; background: var(--kobo-surface);">
      <q-card-section>
        <div class="text-h6">{{ $t('workspaceList.deleteArchivedDialog.title') }}</div>
      </q-card-section>

      <q-card-section class="q-pt-none">
        <div class="text-body2 q-mb-md text-kobo-3">
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
          color="kobo-2"
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
import ManageTagsDialog from 'src/components/ManageTagsDialog.vue'
import WorkspaceCard from 'src/components/WorkspaceCard.vue'
import { useIsMobile } from 'src/composables/use-is-mobile'
import { useDevServerStore } from 'src/stores/dev-server'
import { useLayoutStore } from 'src/stores/layout'
import { useSettingsStore } from 'src/stores/settings'
import { useWebSocketStore } from 'src/stores/websocket'
import type { Workspace } from 'src/stores/workspace'
import { useWorkspaceStore } from 'src/stores/workspace'
import { DEFAULT_TOAST_TIMEOUT_MS } from 'src/utils/notification-timeout'
import type { ProjectColor } from 'src/utils/project-color'
import { projectNameForPath } from 'src/utils/project-color'
import { getAttentionReasons } from 'src/utils/workspace-attention'
import { filterWorkspaces } from 'src/utils/workspace-search'
import { isBusyStatus } from 'src/utils/workspace-status'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

const { t } = useI18n()
const $q = useQuasar()
const store = useWorkspaceStore()
const wsStore = useWebSocketStore()
const devServerStore = useDevServerStore()
const settingsStore = useSettingsStore()
const router = useRouter()
const layout = useLayoutStore()
const { isDrawerCollapsed } = useIsMobile()

function attentionBorderColor(ws: Workspace): string {
  const reasons = getAttentionReasons(ws, store.prSnapshots[ws.id])
  if (reasons.some((r) => r.color === 'red-5')) return 'var(--kobo-danger)' // a real problem → red
  // Purely positive state (ready to merge, nothing else pending) → green, so the
  // border matches the green badge instead of falsely warning with amber.
  if (reasons.length > 0 && reasons.every((r) => r.kind === 'ready-to-merge')) return 'var(--kobo-success)'
  return 'var(--kobo-warning)' // awaiting-user / other intermediate states → amber
}

let workspaceInfoInterval: ReturnType<typeof setInterval> | null = null

// Mémorisée comme les deux autres filtres de la même barre (`favoritesOnly`,
// `searchArchived`) : rien ne justifiait qu'elle seule soit perdue au
// rechargement.
const SEARCH_QUERY_KEY = 'kobo:workspace-search'
const searchQuery = ref<string>(localStorage.getItem(SEARCH_QUERY_KEY) ?? '')
watch(searchQuery, (v) => localStorage.setItem(SEARCH_QUERY_KEY, v))
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

// Recherche approximative sur TOUS les champs que la carte affiche — nom,
// branche, description, étiquettes, projet — et plus seulement sur le nom en
// sous-chaîne exacte. `filterWorkspaces` classe aussi par pertinence quand la
// requête est non vide, et rend la liste intacte quand elle est vide.
const filteredNeedsAttention = computed(() =>
  filterWorkspaces(searchQuery.value, store.needsAttention).filter(
    (w) => !favoritesOnly.value || w.favoritedAt !== null,
  ),
)

const filteredRunning = computed(() =>
  filterWorkspaces(searchQuery.value, store.running).filter((w) => !favoritesOnly.value || w.favoritedAt !== null),
)

const filteredIdle = computed(() =>
  filterWorkspaces(searchQuery.value, store.idle).filter((w) => !favoritesOnly.value || w.favoritedAt !== null),
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
  // `searchArchived` OFF ⇒ la requête n'affecte pas cette section (comportement
  // d'origine). ON ⇒ même moteur approximatif que les sections actives.
  const base = searchArchived.value ? filterWorkspaces(searchQuery.value, store.archived) : store.archived
  return base.filter((w) => !favoritesOnly.value || w.favoritedAt !== null)
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

function toggleAttention() {
  attentionExpanded.value = !attentionExpanded.value
}

function toggleRunning() {
  runningExpanded.value = !runningExpanded.value
}

function toggleIdle() {
  idleExpanded.value = !idleExpanded.value
}

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
    // touch. Show a six-second notification per warning with the command to
    // copy, so the user can recover in one paste without digging in the logs.
    for (const message of warnings) {
      $q.notify({
        type: 'warning',
        message,
        position: 'top',
        timeout: DEFAULT_TOAST_TIMEOUT_MS,
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
          { label: t('common.ok'), color: 'white', handler: () => undefined },
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
        timeout: DEFAULT_TOAST_TIMEOUT_MS,
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
          { label: t('common.ok'), color: 'white', handler: () => undefined },
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

    // L'archivage est RÉVERSIBLE : la règle du projet interdit donc de le
    // barrer d'un dialogue. Mais il faisait disparaître le workspace de la
    // liste sans le moindre signal. Une notification avec une action
    // « Annuler » respecte les deux exigences.
    $q.notify({
      type: 'info',
      message: t('workspaceList.archivedToast', { name: ws.name }),
      position: 'top',
      timeout: DEFAULT_TOAST_TIMEOUT_MS,
      actions: [
        {
          label: t('workspaceList.archivedUndo'),
          color: 'white',
          handler: () => {
            void store
              .unarchiveWorkspace(ws.id)
              .catch(() =>
                $q.notify({ type: 'negative', message: t('workspaceList.unarchiveFailed'), position: 'top' }),
              )
          },
        },
      ],
    })
  } catch (err) {
    console.error('Archive failed:', err)
  }
}

function onPurgeWorktreeClick(ws: Workspace, event: Event) {
  event.stopPropagation()
  $q.dialog({
    title: t('contextMenu.purgeWorktreeDialogTitle'),
    message: t('contextMenu.purgeWorktreeDialogMessage', { name: ws.name }),
    cancel: { flat: true, label: t('common.cancel'), color: 'kobo-2' },
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
      for (const message of result.warnings) {
        $q.notify({
          type: 'warning',
          message,
          position: 'top',
          timeout: DEFAULT_TOAST_TIMEOUT_MS,
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
            { label: t('common.ok'), color: 'white', handler: () => undefined },
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
  // Sous DRAWER_BREAKPOINT (1024 px) le tiroir gauche est une SURIMPRESSION :
  // il recouvre le workspace que ce clic vient précisément d'ouvrir. Le
  // refermer est le geste attendu, pas une commodité. Au-dessus du seuil le
  // tiroir est en flux, il n'y a rien à fermer.
  if (isDrawerCollapsed.value) layout.setLeft(false)
}

/**
 * Roving focus across every rendered card. Reading the DOM rather than keeping
 * an index in sync is deliberate: the four groups can collapse and the flatten
 * setting can reshuffle the rows at any time, so the DOM order is the only
 * ordering that is always right.
 */
function moveFocus(delta: number) {
  const cards = Array.from(document.querySelectorAll<HTMLElement>('.workspace-list [data-testid="workspace-card"]'))
  if (cards.length === 0) return
  const current = cards.indexOf(document.activeElement as HTMLElement)
  const next = current === -1 ? 0 : (current + delta + cards.length) % cards.length
  cards[next]?.focus()
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
    cancel: { flat: true, label: t('common.cancel'), color: 'kobo-2' },
    ok: { unelevated: true, label: t('common.save'), color: 'primary' },
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
    cancel: { flat: true, label: t('common.cancel'), color: 'kobo-2' },
    ok: { unelevated: true, label: t('common.save'), color: 'primary' },
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

const WORKSPACE_INFO_POLL_MS = 15_000

function pollWorkspacesInfoIfVisible(): void {
  // A hidden tab has nobody to inform. Skipping the request also stops the
  // server-side git-stats refresh from running for every tab left open
  // overnight.
  if (document.visibilityState === 'hidden') return
  void store.fetchWorkspacesInfo()
}

function onVisibilityChange(): void {
  // Coming back to the tab: refresh straight away instead of showing stale
  // data for up to WORKSPACE_INFO_POLL_MS.
  if (document.visibilityState === 'visible') void store.fetchWorkspacesInfo()
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
  // Keep every non-archived workspace ≤15s fresh (status + PR + git stats)
  // by polling the server-cached bulk endpoint. Fetch once immediately so the
  // git-stats / CI recap are populated at load instead of after the first tick.
  void store.fetchWorkspacesInfo()
  workspaceInfoInterval = setInterval(pollWorkspacesInfoIfVisible, WORKSPACE_INFO_POLL_MS)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange)
  if (workspaceInfoInterval) {
    clearInterval(workspaceInfoInterval)
    workspaceInfoInterval = null
  }
})
</script>

<style lang="scss" scoped>
.workspace-list {
  background-color: var(--kobo-bg-deep);
  overflow-x: hidden;
}

.wl-search {
  background-color: var(--kobo-surface);
  padding: 0 8px;

  :deep(.q-field__control) {
    height: 32px;
  }
  :deep(input) {
    color: var(--kobo-text-2);
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
</style>
