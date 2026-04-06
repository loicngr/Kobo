<script setup lang="ts">
import { useDevServerStore } from 'src/stores/dev-server'
import { useSettingsStore } from 'src/stores/settings'
import { useWebSocketStore } from 'src/stores/websocket'
import type { Workspace } from 'src/stores/workspace'
import { useWorkspaceStore } from 'src/stores/workspace'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

const store = useWorkspaceStore()
const wsStore = useWebSocketStore()
const devServerStore = useDevServerStore()
const settingsStore = useSettingsStore()
const router = useRouter()
const { t } = useI18n()

const searchQuery = ref('')

interface ProjectGroup {
  projectPath: string
  projectName: string
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
    projectName: path.split('/').pop() ?? path,
    workspaces: wsList,
  }))
}

const filteredNeedsAttention = computed(() =>
  store.needsAttention.filter((w) => w.name.toLowerCase().includes(searchQuery.value.toLowerCase())),
)

const filteredRunning = computed(() =>
  store.running.filter((w) => w.name.toLowerCase().includes(searchQuery.value.toLowerCase())),
)

const filteredIdle = computed(() =>
  store.idle.filter((w) => w.name.toLowerCase().includes(searchQuery.value.toLowerCase())),
)

const groupedNeedsAttention = computed(() => groupByProject(filteredNeedsAttention.value))
const groupedRunning = computed(() => groupByProject(filteredRunning.value))
const groupedIdle = computed(() => groupByProject(filteredIdle.value))

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
    await store.deleteWorkspace(deletedId, {
      deleteLocalBranch: deleteLocalBranch.value,
      deleteRemoteBranch: deleteRemoteBranch.value,
    })
    wsStore.unsubscribe(deletedId)
    deleteDialog.value = false
    // If we were viewing this workspace, navigate away
    if (store.selectedWorkspaceId === null) {
      router.push({ name: 'workspace' })
    }
  } catch (err) {
    console.error('Delete failed:', err)
  } finally {
    deleting.value = false
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
  }
}

function timeAgo(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffMs = now - then
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return t('common.justNow')
  if (diffMin < 60) return t('common.minutesAgo', { n: diffMin })
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return t('common.hoursAgo', { n: diffH })
  const diffD = Math.floor(diffH / 24)
  return t('common.daysAgo', { n: diffD })
}

function selectWorkspace(id: string) {
  store.selectWorkspace(id)
  router.push({ name: 'workspace', params: { id } })
}

function goToCreate() {
  router.push({ name: 'create' })
}

function goToSettings() {
  router.push({ name: 'settings' })
}

onMounted(async () => {
  await store.fetchWorkspaces()
  // Silently fetch archived workspaces so the Archived group header renders
  // if any exist — the group stays collapsed by default.
  await store.fetchArchivedWorkspaces()
  await settingsStore.fetchSettings()
  // Subscribe to ALL workspaces so events are received even when not viewing them
  for (const ws of store.workspaces) {
    wsStore.subscribe(ws.id)
    const project = settingsStore.getProjectByPath(ws.projectPath)
    if (project?.devServer?.startCommand) {
      devServerStore.fetchStatus(ws.id)
    }
  }
})
</script>

<template>
  <div class="workspace-list column full-height">
    <!-- Header -->
    <div class="wl-header row items-center justify-between q-px-md q-py-sm">
      <span class="text-caption text-uppercase text-weight-bold text-grey-6" style="letter-spacing: 0.05em;">
        {{ t('workspaceList.title') }}
      </span>
      <div class="row items-center q-gutter-xs">
        <q-badge
          v-if="wsStore.connected"
          rounded
          color="positive"
          style="width: 8px; height: 8px; min-width: 8px; padding: 0;"
        />
        <q-badge
          v-else
          rounded
          color="negative"
          style="width: 8px; height: 8px; min-width: 8px; padding: 0;"
        />
        <q-btn
          flat
          round
          dense
          icon="settings"
          size="sm"
          color="grey-5"
          @click="goToSettings"
        />
        <q-btn
          flat
          round
          dense
          icon="add"
          size="sm"
          color="grey-5"
          @click="goToCreate"
        />
      </div>
    </div>

    <!-- Search -->
    <div class="q-px-md q-pb-sm">
      <q-input
        v-model="searchQuery"
        dense
        dark
        :placeholder="t('workspaceList.search')"
        class="wl-search rounded-borders"
        borderless
      >
        <template #prepend>
          <q-icon name="search" size="xs" color="grey-6" />
        </template>
      </q-input>
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
            {{ t('workspaceList.needsAttention') }}
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
          <div v-for="group in groupedNeedsAttention" :key="group.projectPath" class="wl-project-group">
            <div v-if="groupedNeedsAttention.length > 1" class="wl-project-label q-px-md q-pt-xs">
              <q-icon name="folder" size="12px" color="grey-7" class="q-mr-xs" />
              <span class="text-caption text-grey-7">{{ group.projectName }}</span>
            </div>
            <div
              v-for="ws in group.workspaces"
              :key="ws.id"
              class="wl-item cursor-pointer q-pa-sm q-mx-xs rounded-borders"
              :class="{ 'wl-item--selected': ws.id === store.selectedWorkspaceId }"
              style="border-left: 3px solid #ef4444;"
              @click="selectWorkspace(ws.id)"
            >
              <div class="col" style="min-width: 0;">
                <div class="row items-center no-wrap q-gutter-xs">
                  <div
                    v-if="devServerStore.getStatus(ws.id)?.status === 'running'"
                    class="dd-dot dd-dot--running"
                  />
                  <div class="wl-item-name text-body2 text-weight-medium text-grey-3 ellipsis">{{ ws.name }}</div>
                </div>
                <div class="text-caption q-mt-xs">
                  <q-icon name="warning" size="xs" color="red-5" class="q-mr-xs" />
                  <span class="text-red-5">{{ ws.status }}</span>
                  <span class="q-ml-xs text-grey-8">&middot; {{ timeAgo(ws.updatedAt) }}</span>
                </div>
              </div>
              <q-btn
                flat round dense
                icon="archive"
                size="xs"
                color="grey-6"
                class="wl-item-action wl-item-archive"
                @click="onArchiveClick(ws, $event)"
              >
                <q-tooltip>{{ t('workspaceList.archiveTooltip') }}</q-tooltip>
              </q-btn>
              <q-btn
                flat
                round
                dense
                icon="delete_outline"
                size="xs"
                color="grey-6"
                class="wl-item-action wl-item-delete"
                @click="openDeleteDialog(ws, $event)"
              >
                <q-tooltip>{{ t('workspaceList.deleteTooltip') }}</q-tooltip>
              </q-btn>
            </div>
          </div>
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
            {{ t('workspaceList.running') }}
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
          <div v-for="group in groupedRunning" :key="group.projectPath" class="wl-project-group">
            <div v-if="groupedRunning.length > 1" class="wl-project-label q-px-md q-pt-xs">
              <q-icon name="folder" size="12px" color="grey-7" class="q-mr-xs" />
              <span class="text-caption text-grey-7">{{ group.projectName }}</span>
            </div>
            <div
              v-for="ws in group.workspaces"
              :key="ws.id"
              class="wl-item cursor-pointer q-pa-sm q-mx-xs rounded-borders"
              :class="{ 'wl-item--selected': ws.id === store.selectedWorkspaceId }"
              style="border-left: 3px solid #4ade80;"
              @click="selectWorkspace(ws.id)"
            >
              <div class="col" style="min-width: 0;">
                <div class="row items-center no-wrap q-gutter-xs">
                  <div
                    v-if="devServerStore.getStatus(ws.id)?.status === 'running'"
                    class="dd-dot dd-dot--running"
                  />
                  <div class="wl-item-name text-body2 text-weight-medium text-grey-3 ellipsis">{{ ws.name }}</div>
                </div>
                <div class="text-caption q-mt-xs">
                  <span class="text-green-4">{{ ws.status }}</span>
                  <span class="q-ml-xs text-grey-8">&middot; {{ timeAgo(ws.updatedAt) }}</span>
                </div>
              </div>
              <q-btn
                flat round dense
                icon="archive"
                size="xs"
                color="grey-6"
                class="wl-item-action wl-item-archive"
                @click="onArchiveClick(ws, $event)"
              >
                <q-tooltip>{{ t('workspaceList.archiveTooltip') }}</q-tooltip>
              </q-btn>
              <q-btn
                flat
                round
                dense
                icon="delete_outline"
                size="xs"
                color="grey-6"
                class="wl-item-action wl-item-delete"
                @click="openDeleteDialog(ws, $event)"
              >
                <q-tooltip>{{ t('workspaceList.deleteTooltip') }}</q-tooltip>
              </q-btn>
            </div>
          </div>
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
            {{ t('workspaceList.idle') }}
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
          <div v-for="group in groupedIdle" :key="group.projectPath" class="wl-project-group">
            <div v-if="groupedIdle.length > 1" class="wl-project-label q-px-md q-pt-xs">
              <q-icon name="folder" size="12px" color="grey-7" class="q-mr-xs" />
              <span class="text-caption text-grey-7">{{ group.projectName }}</span>
            </div>
            <div
              v-for="ws in group.workspaces"
              :key="ws.id"
              class="wl-item cursor-pointer q-pa-sm q-mx-xs rounded-borders"
              :class="{ 'wl-item--selected': ws.id === store.selectedWorkspaceId }"
              style="border-left: 3px solid #666;"
              @click="selectWorkspace(ws.id)"
            >
              <div class="col" style="min-width: 0;">
                <div class="row items-center no-wrap q-gutter-xs">
                  <div
                    v-if="devServerStore.getStatus(ws.id)?.status === 'running'"
                    class="dd-dot dd-dot--running"
                  />
                  <div class="wl-item-name text-body2 text-weight-medium text-grey-3 ellipsis">{{ ws.name }}</div>
                </div>
                <div class="wl-item-meta text-caption text-grey-8">
                  {{ timeAgo(ws.updatedAt) }}
                </div>
              </div>
              <q-btn
                flat round dense
                icon="archive"
                size="xs"
                color="grey-6"
                class="wl-item-action wl-item-archive"
                @click="onArchiveClick(ws, $event)"
              >
                <q-tooltip>{{ t('workspaceList.archiveTooltip') }}</q-tooltip>
              </q-btn>
              <q-btn
                flat
                round
                dense
                icon="delete_outline"
                size="xs"
                color="grey-6"
                class="wl-item-action wl-item-delete"
                @click="openDeleteDialog(ws, $event)"
              >
                <q-tooltip>{{ t('workspaceList.deleteTooltip') }}</q-tooltip>
              </q-btn>
            </div>
          </div>
        </div>
      </div>

      <!-- Archived -->
      <div v-if="store.archived.length > 0 || archivedExpanded" class="wl-group q-mt-xs">
        <div
          class="wl-group-header row items-center q-px-md q-py-xs cursor-pointer non-selectable"
          @click="toggleArchived"
        >
          <q-icon
            :name="archivedExpanded ? 'expand_more' : 'chevron_right'"
            size="xs"
            color="grey-7"
          />
          <q-icon name="inventory_2" size="xs" color="grey-7" class="q-ml-xs" />
          <span class="text-caption text-weight-bold q-ml-xs text-grey-7">
            {{ t('workspaceList.archived') }}
          </span>
          <q-badge
            v-if="store.archived.length > 0"
            :label="store.archived.length"
            color="grey-9"
            text-color="grey-5"
            class="q-ml-auto"
            style="font-size: 10px;"
          />
        </div>

        <div v-show="archivedExpanded">
          <div
            v-for="ws in store.archived"
            :key="ws.id"
            class="wl-item wl-item--archived q-pa-sm q-mx-xs rounded-borders"
            style="border-left: 3px solid #555;"
          >
            <div class="col" style="min-width: 0;">
              <div class="wl-item-name text-body2 text-grey-5 ellipsis">{{ ws.name }}</div>
              <div class="wl-item-meta text-caption text-grey-8">
                {{ t('workspaceList.archivedAgo', { timeAgo: timeAgo(ws.archivedAt!) }) }}
              </div>
            </div>
            <q-btn
              flat round dense
              icon="unarchive"
              size="xs"
              color="grey-6"
              class="wl-item-action wl-item-unarchive"
              @click="onUnarchiveClick(ws, $event)"
            >
              <q-tooltip>{{ t('workspaceList.unarchiveTooltip') }}</q-tooltip>
            </q-btn>
            <q-btn
              flat round dense
              icon="delete_outline"
              size="xs"
              color="grey-6"
              class="wl-item-action wl-item-delete"
              @click="openDeleteDialog(ws, $event)"
            >
              <q-tooltip>{{ t('workspaceList.deleteTooltip') }}</q-tooltip>
            </q-btn>
          </div>
        </div>
      </div>

      <!-- Empty state -->
      <div
        v-if="filteredNeedsAttention.length === 0 && filteredRunning.length === 0 && filteredIdle.length === 0 && store.archived.length === 0"
        class="q-pa-lg text-center text-grey-6 text-caption"
      >
        <template v-if="store.loading">{{ t('common.loading') }}</template>
        <template v-else-if="searchQuery">{{ t('workspaceList.noResults', { query: searchQuery }) }}</template>
        <template v-else>{{ t('workspaceList.noWorkspaces') }}</template>
      </div>
    </div>

    <q-separator dark />

    <!-- Footer counter -->
    <div class="q-px-md q-py-xs text-caption text-grey-8">
      {{ t('workspaceList.workspaceWord', totalCount) }} &middot; {{ t('workspaceList.footerRunning', { n: runningCount }) }}
    </div>
  </div>

  <!-- Delete confirmation dialog -->
  <q-dialog v-model="deleteDialog" persistent>
    <q-card class="text-grey-3" style="min-width: 360px; background: #1e1e3a;">
      <q-card-section>
        <div class="text-h6">{{ t('workspaceList.deleteDialogTitle') }}</div>
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
            :label="t('workspaceList.deleteLocalBranch')"
            dark
            dense
            color="red-5"
          />
          <q-checkbox
            v-model="deleteRemoteBranch"
            :disable="!deleteLocalBranch"
            :label="t('workspaceList.deleteRemoteBranch')"
            dark
            dense
            color="red-5"
          />
        </div>
        <div v-if="deleteRemoteBranch" class="text-caption q-mt-sm text-red-5">
          {{ t('workspaceList.deleteWarning') }}
        </div>
      </q-card-section>

      <q-card-actions align="right">
        <q-btn flat :label="t('workspaceList.cancelBtn')" color="grey-5" @click="deleteDialog = false" :disable="deleting" />
        <q-btn
          flat
          :label="t('workspaceList.deleteBtn')"
          color="red-5"
          :loading="deleting"
          @click="confirmDelete"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

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
  transition: background-color 0.15s;
  margin-bottom: 4px;

  &:last-child { margin-bottom: 0; }
  &:hover { background-color: #2a2a4a; }
  &--selected {
    background-color: #2a2a4a;
    outline: 1px solid rgba(108, 99, 255, 0.4);
  }
}

.wl-item-action {
  opacity: 0;
  transition: opacity 0.15s;
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
}

.wl-item-delete { right: 4px; }
.wl-item-archive,
.wl-item-unarchive { right: 28px; }

.wl-item:hover .wl-item-action {
  opacity: 1;
}

.wl-item--archived {
  opacity: 0.6;
  background-color: #1a1a30;

  &:hover { opacity: 0.85; }
  &.wl-item--selected { opacity: 1; }
}

.dd-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;

  &--running {
    background-color: #22c55e;
    box-shadow: 0 0 4px rgba(34, 197, 94, 0.5);
  }
}
</style>
