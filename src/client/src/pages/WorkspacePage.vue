<template>
  <q-page class="column no-wrap" :style-fn="workspacePageStyle">
    <!-- Header bar -->
    <div class="wp-header row items-center q-px-md q-py-sm no-wrap">
      <q-btn
        flat
        dense
        round
        size="sm"
        :icon="layout.leftDrawerOpen ? 'menu_open' : 'menu'"
        class="q-mr-sm"
        @click="layout.toggleLeft()"
      >
        <q-tooltip>{{ $t('layout.toggleWorkspaces') }}</q-tooltip>
      </q-btn>
      <template v-if="selectedWs">
        <span class="text-body1 text-weight-medium text-kobo-1 ellipsis" style="max-width: 480px;">
          {{ selectedWs.name }}
          <q-tooltip>{{ selectedWs.name }}</q-tooltip>
        </span>
        <q-badge
          :label="workspaceStatusLabel(selectedWs.id, selectedWs.status)"
          :color="workspaceStatusColor(selectedWs.id, selectedWs.status)"
          class="q-ml-sm"
          style="font-size: 10px;"
        />
        <template v-if="!isMobile">
          <WorkspaceToolbarSelectors
            layout="inline"
            :sessions="sessions"
            :session-options="sessionOptions"
            :permission-mode-options="permissionModeOptions"
            :model-options="modelOptions"
            :reasoning-options="reasoningOptions"
            :pending-spawn-changes="pendingSpawnChanges"
            :creating-session="creatingSession"
            :can-delete-session="sessionCanBeDeleted"
            :active-session-model-label="toolbarActiveSessionModelLabel"
            v-model:selected-session-id="selectedSessionId"
            v-model:permission-mode="currentPermissionMode"
            v-model:model="currentModel"
            v-model:reasoning-effort="currentReasoningEffort"
            @rename="openRenameDialog"
            @copy-session-id="copyEngineSessionId"
            @delete-session="confirmDeleteSession"
          />
        </template>
        <q-space v-else />
        <WorkspaceWhipControl
          v-if="selectedWs && !selectedWs.archivedAt"
          :workspace-id="selectedWs.id"
          :session-id="whipRunningSessionId"
          :running="whipRunningSessionId !== null"
        />
        <q-btn
          v-if="!isMobile"
          flat
          dense
          no-caps
          size="sm"
          class="q-mr-xs palette-shortcut-hint"
          label="⌘K"
          @click="
            () => {
              commandPaletteQuery = ''
              commandPaletteOpen = true
            }
          "
        >
          <q-tooltip>{{ $t('workspacePage.commandPaletteHint') }}</q-tooltip>
        </q-btn>
        <q-btn
          v-if="isBusyStatus(selectedWs.status) && !selectedWs.archivedAt"
          dense
          no-caps
          size="sm"
          color="negative"
          icon="stop"
          :label="isMobile ? undefined : $t('common.stop')"
          class="q-mr-xs"
          :loading="stopping"
          :disable="stopping"
          @click="handleStop"
        />
        <q-btn
          v-if="isMobile"
          flat
          dense
          round
          icon="more_vert"
          :aria-label="$t('workspacePage.moreActions')"
        >
          <q-tooltip>{{ $t('workspacePage.moreActions') }}</q-tooltip>
          <q-menu>
            <q-list style="min-width: 240px">
              <WorkspaceToolbarSelectors
                layout="menu"
                :sessions="sessions"
                :session-options="sessionOptions"
                :permission-mode-options="permissionModeOptions"
                :model-options="modelOptions"
                :reasoning-options="reasoningOptions"
                :pending-spawn-changes="pendingSpawnChanges"
                :creating-session="creatingSession"
                :can-delete-session="sessionCanBeDeleted"
                :active-session-model-label="toolbarActiveSessionModelLabel"
                v-model:selected-session-id="selectedSessionId"
                v-model:permission-mode="currentPermissionMode"
                v-model:model="currentModel"
                v-model:reasoning-effort="currentReasoningEffort"
                @rename="openRenameDialog"
                @copy-session-id="copyEngineSessionId"
                @delete-session="confirmDeleteSession"
              />
            </q-list>
          </q-menu>
        </q-btn>
      </template>
      <template v-else>
        <span class="text-body2 text-kobo-3">
          {{ $t('workspacePage.selectWorkspace') }}
        </span>
        <q-space />
      </template>
      <q-btn
        flat
        dense
        round
        size="sm"
        icon="view_sidebar"
        @click="layout.toggleRight()"
      >
        <q-tooltip>{{ $t('layout.togglePanel') }}</q-tooltip>
      </q-btn>
    </div>

    <!-- Workspace description (own line under the header) -->
    <div v-if="selectedWs" class="wp-subheader column q-px-md q-pb-sm">
      <q-input
        v-model="descriptionDraft"
        dense
        dark
        borderless
        :placeholder="t('workspace.descriptionPlaceholder')"
        :maxlength="200"
        input-class="text-caption text-kobo-2"
        class="workspace-description-input"
        style="width: 100%; max-width: 960px;"
        @blur="saveDescription"
        @keydown.enter.prevent="saveDescription"
      />
      <div
        v-if="selectedWs?.agentDescription"
        class="text-caption text-kobo-3 q-mt-xs ellipsis"
        style="font-style: italic; max-width: 960px;"
        :title="t('workspace.agentDescriptionTooltip')"
      >
        {{ selectedWs.agentDescription }}
      </div>
    </div>

    <q-separator dark />

    <div
      v-if="selectedWs?.worktreePurgedAt"
      class="wp-purged-banner row items-center q-px-md q-py-sm"
    >
      <q-icon name="cleaning_services" size="16px" color="orange-5" class="q-mr-sm" />
      <span class="text-caption text-kobo-1">
        {{ $t('workspacePage.worktreePurgedBanner') }}
      </span>
      <q-space />
      <q-btn flat dense size="sm" no-caps color="kobo-2" icon="info_outline" :label="$t('common.details')">
        <q-tooltip max-width="320px" anchor="bottom right" self="top right">
          {{ $t('workspacePage.worktreePurgedTooltip') }}
        </q-tooltip>
      </q-btn>
    </div>

    <div
      v-else-if="selectedWs?.archivedAt"
      class="wp-archived-banner row items-center q-px-md q-py-sm"
    >
      <q-icon name="inventory_2" size="16px" color="kobo-2" class="q-mr-sm" />
      <span class="text-caption text-kobo-2">
        {{ $t('workspacePage.archivedBanner') }}
      </span>
      <q-space />
      <q-btn
        flat
        dense
        size="sm"
        no-caps
        color="primary"
        icon="unarchive"
        :label="$t('common.unarchive')"
        :loading="unarchiving"
        :disable="unarchiving"
        @click="handleUnarchive"
      />
    </div>

    <div
      v-if="hasPendingInitialPrompt"
      class="wp-pending-prompt-banner row items-center q-px-md q-py-sm"
    >
      <q-icon name="warning" size="16px" color="amber-5" class="q-mr-sm" />
      <span class="text-caption text-kobo-1">
        {{ $t('workspacePage.pendingInitialPromptBanner') }}
      </span>
      <q-space />
      <q-btn
        unelevated
        dense
        size="sm"
        no-caps
        color="primary"
        icon="play_arrow"
        :label="$t('common.start')"
        :loading="starting"
        :disable="starting"
        @click="handleStart"
      />
    </div>

    <AgentErrorBanner v-if="selectedId" :workspace-id="selectedId" />
    <StaleSessionBanner v-if="selectedId" :workspace-id="selectedId" />
    <QuotaBackoffBanner v-if="selectedId" :workspace-id="selectedId" />
    <WorkspaceHistorySearch
      v-if="selectedId && historySearchOpen"
      :key="selectedId"
      :workspace-id="selectedId"
      @close="historySearchOpen = false"
    />

    <!-- Activity Feed with Suspense -->
    <Suspense v-if="selectedId">
      <ActivityFeed class="col" style="min-height: 0;" :workspace-id="selectedId" />
      <template #fallback>
        <div class="col column items-center justify-center">
          <q-spinner-dots size="40px" color="primary" />
          <div class="text-kobo-3 text-caption q-mt-sm">{{ $t('common.loading') }}</div>
        </div>
      </template>
    </Suspense>

    <AgentBusyBanner />
    <WakeupBanner />
    <AskUserQuestionPanel v-if="selectedId" :workspace-id="selectedId" />
    <PermissionRequestPanel v-if="selectedId" :workspace-id="selectedId" />
    <LatestThinkingPanel v-if="selectedId" :workspace-id="selectedId" />

    <!-- Chat Input — pinned at bottom -->
    <ChatInput
      v-if="selectedId"
      ref="chatInputRef"
      :workspace-id="selectedId"
    />
    <q-dialog v-model="commandPaletteOpen">
      <q-card dark class="command-palette-card">
        <q-card-section class="q-pb-sm">
          <q-input
            ref="commandPaletteInput"
            v-model="commandPaletteQuery"
            autofocus
            dark
            dense
            borderless
            :placeholder="t('workspacePage.commandPalettePlaceholder')"
            @keydown.esc="commandPaletteOpen = false"
          >
            <template #prepend><q-icon name="search" /></template>
          </q-input>
        </q-card-section>
        <q-separator dark />
        <q-list dense class="q-py-sm">
          <q-item
            v-for="command in filteredCommands"
            :key="command.id"
            clickable
            v-ripple
            @click="runCommand(command)"
          >
            <q-item-section avatar><q-icon :name="command.icon" color="primary" /></q-item-section>
            <q-item-section>
              <q-item-label>{{ command.label }}</q-item-label>
              <q-item-label v-if="command.hint" caption class="palette-hint">{{ command.hint }}</q-item-label>
            </q-item-section>
          </q-item>
          <q-item v-if="filteredCommands.length === 0" dense>
            <q-item-section class="text-kobo-3">{{ t('workspacePage.commandPaletteEmpty') }}</q-item-section>
          </q-item>
        </q-list>
      </q-card>
    </q-dialog>
    <q-dialog v-model="renameDialogOpen" persistent>
      <q-card dark style="min-width: 320px;">
        <q-card-section>
          <div class="text-subtitle1">{{ t('workspacePage.renameSessionTitle') }}</div>
        </q-card-section>
        <q-card-section>
          <q-input
            v-model="renameValue"
            :label="t('workspacePage.sessionNameLabel')"
            dark
            dense
            autofocus
            @keyup.enter="handleRename"
          />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat :label="t('common.cancel')" v-close-popup />
          <q-btn
            flat
            color="primary"
            :label="t('workspacePage.renameSession')"
            :disable="!renameValue.trim()"
            @click="handleRename"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup lang="ts">
import { useQuasar } from 'quasar'
import { useIsMobile } from 'src/composables/use-is-mobile'
import { EFFORT_OPTION_DEFS_BY_ENGINE } from 'src/constants/efforts'
import { MODEL_OPTION_DEFS, MODEL_OPTION_DEFS_BY_ENGINE } from 'src/constants/models'
import { PERMISSION_MODES_BY_ENGINE } from 'src/constants/permissionModes'
import { useLayoutStore } from 'src/stores/layout'
import type { AgentSession } from 'src/stores/workspace'
import { useWorkspaceStore } from 'src/stores/workspace'
import { copyToClipboard } from 'src/utils/clipboard'
import { isTypingTarget, type PaletteEntry, rankCommands } from 'src/utils/command-palette'
import { useTimeAgo } from 'src/utils/formatters'
import { getWhipRunningSessionId } from 'src/utils/whip-session'
import { workspacePageStyle } from 'src/utils/workspace-page-layout'
import { isBusyStatus, workspaceStatusKey } from 'src/utils/workspace-status'
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'

// No artificial delay: ActivityFeed shows its own 200 ms switch spinner
// (WORKSPACE_SWITCH_SPINNER_MS), so padding the chunk load with half a second
// added latency to every workspace open and hid nothing.
const ActivityFeed = defineAsyncComponent(() => import('src/components/ActivityFeed.vue'))

import AgentBusyBanner from 'src/components/AgentBusyBanner.vue'
import AgentErrorBanner from 'src/components/AgentErrorBanner.vue'
import AskUserQuestionPanel from 'src/components/AskUserQuestionPanel.vue'
import ChatInput from 'src/components/ChatInput.vue'
import LatestThinkingPanel from 'src/components/LatestThinkingPanel.vue'
import PermissionRequestPanel from 'src/components/PermissionRequestPanel.vue'
import QuotaBackoffBanner from 'src/components/QuotaBackoffBanner.vue'
import StaleSessionBanner from 'src/components/StaleSessionBanner.vue'
import WakeupBanner from 'src/components/WakeupBanner.vue'
import WorkspaceHistorySearch from 'src/components/WorkspaceHistorySearch.vue'
import WorkspaceToolbarSelectors from 'src/components/WorkspaceToolbarSelectors.vue'
import WorkspaceWhipControl from 'src/components/WorkspaceWhipControl.vue'

const $q = useQuasar()
const { isMobile } = useIsMobile()
const store = useWorkspaceStore()
const layout = useLayoutStore()
const { t } = useI18n()
const { timeAgo } = useTimeAgo()

function statusLabel(status: string): string {
  const key = workspaceStatusKey(status)
  // Statut inconnu de ce build : on rend la valeur brute plutôt que rien —
  // un serveur plus récent reste lisible.
  return key ? t(key) : status
}

function workspaceStatusLabel(workspaceId: string, status: string): string {
  if (status === 'quota' && store.pendingQuotaBackoffs[workspaceId]?.reason === 'transient') {
    return t('workspaceStatus.retrying')
  }
  return statusLabel(status)
}

function workspaceStatusColor(workspaceId: string, status: string): string {
  if (status === 'quota' && store.pendingQuotaBackoffs[workspaceId]?.reason === 'transient') return 'amber-9'
  if (['error', 'quota'].includes(status)) return 'red-9'
  if (status === 'awaiting-user') return 'amber-9'
  return isBusyStatus(status) ? 'green-9' : 'kobo-3'
}

const starting = ref(false)
const stopping = ref(false)
const historySearchOpen = ref(false)
const commandPaletteOpen = ref(false)
const commandPaletteQuery = ref('')
const commandPaletteInput = ref<{ focus: () => void } | null>(null)
const chatInputRef = ref<{ focus: () => void } | null>(null)
const pendingWorkspaceUpdates = new Set<Promise<unknown>>()

function onWorkspaceShortcut(event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey)) return
  const key = event.key.toLowerCase()
  if (key === 'k') {
    // ⌘K reste global : c'est la convention, et l'ouvrir depuis un champ est
    // exactement ce qu'on attend d'une palette.
    event.preventDefault()
    commandPaletteQuery.value = ''
    commandPaletteOpen.value = true
    void nextTick(() => commandPaletteInput.value?.focus())
  } else if (key === 'f') {
    // ⌘F était intercepté MÊME pendant la rédaction d'un message : la
    // recherche du navigateur disparaissait sans explication.
    if (isTypingTarget(event.target)) return
    event.preventDefault()
    historySearchOpen.value = true
  }
}

const workspaceCommands = computed<PaletteEntry[]>(() => {
  const commands: PaletteEntry[] = [
    {
      id: 'focus-chat',
      label: t('workspacePage.commandFocusChat'),
      icon: 'chat',
      run: () => void nextTick(() => chatInputRef.value?.focus()),
    },
    {
      id: 'search-history',
      label: t('workspacePage.commandSearchHistory'),
      icon: 'search',
      run: () => {
        historySearchOpen.value = true
      },
    },
    {
      id: 'toggle-panel',
      label: t('workspacePage.commandTogglePanel'),
      icon: 'view_sidebar',
      run: () => layout.toggleRight(),
    },
  ]
  if (selectedWs.value && !selectedWs.value.archivedAt) {
    if (isBusyStatus(selectedWs.value.status)) {
      commands.push(
        {
          id: 'interrupt-agent',
          label: t('workspacePage.interrupt'),
          icon: 'pause',
          hint: t('workspacePage.interruptHint'),
          run: () => void handleInterrupt(),
        },
        { id: 'stop-agent', label: t('workspacePage.commandStopAgent'), icon: 'stop', run: () => void handleStop() },
      )
    } else {
      commands.push({
        id: 'start-agent',
        label: t('workspacePage.commandStartAgent'),
        icon: 'play_arrow',
        run: () => void handleStart(),
      })
    }
  }

  // Navigation. La palette ne sortait pas du workspace courant : ni réglages,
  // ni création, ni recherche globale n'y étaient atteignables.
  commands.push(
    {
      id: 'open-create',
      label: t('workspacePage.commandOpenCreate'),
      icon: 'add',
      run: () => void router.push({ name: 'create' }),
    },
    {
      id: 'open-settings',
      label: t('workspacePage.commandOpenSettings'),
      icon: 'settings',
      run: () => void router.push({ name: 'settings' }),
    },
    {
      id: 'open-search',
      label: t('workspacePage.commandOpenSearch'),
      icon: 'manage_search',
      run: () => void router.push({ name: 'search' }),
    },
    {
      id: 'open-health',
      label: t('workspacePage.commandOpenHealth'),
      icon: 'monitor_heart',
      run: () => void router.push({ name: 'health' }),
    },
    {
      id: 'open-changelog',
      label: t('workspacePage.commandOpenChangelog'),
      icon: 'history',
      run: () => void router.push({ name: 'changelog' }),
    },
  )

  // Saut direct vers n'importe quel workspace non archivé — l'usage premier
  // d'une palette, et le seul qui manquait vraiment.
  for (const ws of store.workspaces) {
    if (ws.archivedAt) continue
    if (ws.id === store.selectedWorkspaceId) continue
    commands.push({
      id: `goto-${ws.id}`,
      label: ws.name,
      icon: 'folder_open',
      hint: `${t('workspacePage.commandGroupWorkspaces')} · ${ws.workingBranch}`,
      run: () => {
        store.selectWorkspace(ws.id)
        void router.push({ name: 'workspace', params: { id: ws.id } })
      },
    })
  }

  return commands
})

// Classement approximatif partagé, testé dans `command-palette.test.ts`.
const filteredCommands = computed(() => rankCommands(commandPaletteQuery.value, workspaceCommands.value))

function runCommand(command: PaletteEntry): void {
  commandPaletteOpen.value = false
  command.run()
}

// True when the workspace has a brainstorm prompt waiting to be replayed —
// happens when the setup script crashed at creation time and the agent
// never received the original instructions. Surfacing the banner gives the
// user a one-click path to retry with the saved prompt.
const hasPendingInitialPrompt = computed(
  () =>
    !!store.selectedWorkspace?.initialPrompt &&
    store.selectedWorkspace.initialPrompt.length > 0 &&
    !isAgentRunning.value &&
    !store.selectedWorkspace?.archivedAt,
)

const descriptionDraft = ref<string>('')

watch(
  () => store.selectedWorkspace?.description ?? '',
  (val) => {
    descriptionDraft.value = val
  },
  { immediate: true },
)

async function saveDescription(): Promise<void> {
  if (!store.selectedWorkspace) return
  const next = descriptionDraft.value.trim()
  const current = store.selectedWorkspace.description ?? ''
  if (next === current) return // no-op
  if (next.length > 200) {
    $q.notify({ type: 'negative', message: t('workspace.descriptionTooLong'), position: 'top' })
    return
  }
  try {
    await store.updateWorkspaceDescription(store.selectedWorkspace.id, next.length > 0 ? next : null)
  } catch (err) {
    const message = err instanceof Error ? err.message : t('workspace.descriptionSaveFailed')
    $q.notify({ type: 'negative', message, position: 'top' })
  }
}

// Fields that deal with agent-spawn-time flags (--model, --effort, plan mode).
// When the user changes them while an agent is already running, the change
// doesn't affect the current turn — it's only picked up on the next spawn.
// We surface a small "pending" indicator until the workspace leaves its running
// state, at which point any new start will naturally consume the fresh values.
type SpawnField = 'model' | 'reasoningEffort' | 'agentPermissionMode'
const pendingSpawnChanges = ref<Set<SpawnField>>(new Set())

const isAgentRunning = computed(() => isBusyStatus(store.selectedWorkspace?.status))

watch(isAgentRunning, (running) => {
  if (!running) pendingSpawnChanges.value = new Set()
})

watch(
  () => store.selectedWorkspaceId,
  (newId) => {
    pendingSpawnChanges.value = new Set()
    if (newId) void store.fetchPendingWakeup(newId)
  },
  { immediate: true },
)

function markSpawnFieldPending(field: SpawnField): void {
  if (!isAgentRunning.value) return
  const next = new Set(pendingSpawnChanges.value)
  next.add(field)
  pendingSpawnChanges.value = next
}

function trackWorkspaceUpdate(promise: Promise<unknown>) {
  pendingWorkspaceUpdates.add(promise)
  promise.finally(() => {
    pendingWorkspaceUpdates.delete(promise)
  })
}

async function waitForPendingWorkspaceUpdates() {
  if (pendingWorkspaceUpdates.size === 0) return
  await Promise.allSettled([...pendingWorkspaceUpdates])
}

async function handleStart() {
  if (!store.selectedWorkspaceId) return
  starting.value = true
  try {
    await waitForPendingWorkspaceUpdates()
    await store.startWorkspace(store.selectedWorkspaceId)
  } catch (e) {
    const msg = e instanceof Error ? e.message : t('workspacePage.startFailed')
    $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
  } finally {
    starting.value = false
  }
}

const interrupting = ref(false)
const unarchiving = ref(false)

async function handleUnarchive() {
  if (!store.selectedWorkspaceId || unarchiving.value) return
  const id = store.selectedWorkspaceId
  unarchiving.value = true
  try {
    await store.unarchiveWorkspace(id)
    $q.notify({ type: 'positive', message: t('workspacePage.unarchived'), position: 'top', timeout: 3000 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : t('workspacePage.unarchiveFailed')
    $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
  } finally {
    unarchiving.value = false
  }
}

async function handleInterrupt() {
  if (!store.selectedWorkspaceId) return
  interrupting.value = true
  try {
    await store.interruptAgent(store.selectedWorkspaceId)
    $q.notify({ type: 'info', message: t('workspacePage.interrupted'), position: 'top', timeout: 3000 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : t('workspacePage.interruptFailed')
    $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
  } finally {
    interrupting.value = false
  }
}

async function handleStop() {
  if (!store.selectedWorkspaceId) return
  stopping.value = true
  try {
    await store.stopWorkspace(store.selectedWorkspaceId)
  } catch (e) {
    const msg = e instanceof Error ? e.message : t('workspacePage.stopFailed')
    $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
  } finally {
    stopping.value = false
  }
}

// All selectors below are driven by the active workspace's engine id (a
// fixed value, set at creation). Falling back to Claude's full lists when the
// engine id is unknown keeps existing workspaces working through any future
// schema change.
const currentEngineId = computed<string>(() => store.selectedWorkspace?.engine ?? 'claude-code')

const modelOptions = computed(() => {
  const defs = MODEL_OPTION_DEFS_BY_ENGINE[currentEngineId.value] ?? MODEL_OPTION_DEFS
  return defs.map((option) => ({ label: t(option.i18nLabelKey), value: option.value }))
})

const reasoningOptions = computed(() => {
  const defs = EFFORT_OPTION_DEFS_BY_ENGINE[currentEngineId.value] ?? EFFORT_OPTION_DEFS_BY_ENGINE['claude-code']
  return defs.map((d) => ({
    label: formatReasoningLabel(t(d.i18nLabelKey)),
    value: d.value,
  }))
})

const permissionModeOptions = computed(() => {
  const ws = store.selectedWorkspace
  const autoLoopOn = ws ? (store.autoLoopStates[ws.id]?.auto_loop ?? ws.autoLoop) : false
  const supported = PERMISSION_MODES_BY_ENGINE[currentEngineId.value] ?? PERMISSION_MODES_BY_ENGINE['claude-code']
  return supported.map((mode) => ({
    label: t(`agentPermissionMode.${mode}`),
    value: mode,
    // `plan` is disabled while auto-loop is on (loop needs to execute, not plan).
    disable: mode === 'plan' && autoLoopOn,
  }))
})

const currentModel = computed({
  get: () => store.selectedWorkspace?.model ?? 'auto',
  set: (val: string) => {
    if (store.selectedWorkspaceId) {
      markSpawnFieldPending('model')
      trackWorkspaceUpdate(store.updateModel(store.selectedWorkspaceId, val))
    }
  },
})

const currentReasoningEffort = computed({
  get: () => store.selectedWorkspace?.reasoningEffort ?? 'auto',
  set: (val: string) => {
    if (store.selectedWorkspaceId) {
      markSpawnFieldPending('reasoningEffort')
      trackWorkspaceUpdate(store.updateReasoningEffort(store.selectedWorkspaceId, val))
    }
  },
})

function formatReasoningLabel(label: string): string {
  const separatorIndex = label.indexOf(':')
  if (separatorIndex >= 0) return label.slice(separatorIndex + 1).trim()
  return label
}

type AgentPermissionModeValue = 'plan' | 'bypass' | 'strict' | 'interactive'

const currentPermissionMode = computed<AgentPermissionModeValue>({
  get: () => store.selectedWorkspace?.agentPermissionMode ?? 'bypass',
  set: (val: AgentPermissionModeValue) => {
    if (store.selectedWorkspaceId) {
      markSpawnFieldPending('agentPermissionMode')
      trackWorkspaceUpdate(store.updateAgentPermissionMode(store.selectedWorkspaceId, val))
    }
  },
})

const route = useRoute()
const router = useRouter()

const selectedId = computed(() => store.selectedWorkspaceId)
const selectedWs = computed(() => store.selectedWorkspace)

const sessions = computed(() => store.sessions)
const whipRunningSessionId = computed(() => {
  const workspace = selectedWs.value
  if (!workspace || !isBusyStatus(workspace.status)) return null
  return getWhipRunningSessionId(workspace.id, store.sessions)
})
const selectedSession = computed(() => store.sessions.find((session) => session.id === store.selectedSessionId) ?? null)
const selectedSessionModel = computed(() => selectedSession.value?.model ?? null)
const activeSessionModelLabel = computed(
  () =>
    modelOptions.value.find((option) => option.value === selectedSessionModel.value)?.label ??
    selectedSessionModel.value,
)
const toolbarActiveSessionModelLabel = computed(() =>
  selectedSessionModel.value !== null && selectedSessionModel.value !== selectedWs.value?.model
    ? activeSessionModelLabel.value
    : null,
)
const selectedSessionId = computed({
  get: () => store.selectedSessionId,
  set: (val: string | null) => {
    if (val === '__new__') {
      handleCreateSession()
      return
    }
    if (!val) return
    store.selectSession(val)
    const query = { ...route.query }
    query.session = val
    router.replace({ query })
  },
})

const sessionOptions = computed(() => {
  const opts = store.sessions.map((s: AgentSession, idx: number) => ({
    label: s.name ?? t('workspacePage.session', { n: store.sessions.length - idx }),
    value: s.id,
    caption: s.engine
      ? `${s.engine === 'codex' ? t('workspacePage.engineCodex') : t('workspacePage.engineClaude')} · ${timeAgo(s.startedAt)}`
      : timeAgo(s.startedAt),
    isSession: true,
  }))
  return [...opts, { label: t('workspacePage.newSession'), value: '__new__', caption: '', isSession: false }]
})

const renameDialogOpen = ref(false)
const renameTarget = ref<{ id: string } | null>(null)
const renameValue = ref('')
const creatingSession = ref(false)

function copyEngineSessionId(sessionId: string) {
  const session = store.sessions.find((s) => s.id === sessionId)
  if (!session?.engineSessionId) {
    $q.notify({ type: 'warning', message: t('workspacePage.noEngineSessionId'), position: 'top' })
    return
  }
  void copyToClipboard($q, t, session.engineSessionId)
}

function openRenameDialog(sessionId: string, currentLabel: string) {
  const session = store.sessions.find((s) => s.id === sessionId)
  if (!session) return
  renameTarget.value = { id: sessionId }
  renameValue.value = session.name ?? currentLabel
  renameDialogOpen.value = true
}

function sessionCanBeDeleted(sessionId: string): boolean {
  return store.sessions.find((session) => session.id === sessionId)?.status !== 'running'
}

function confirmDeleteSession(sessionId: string) {
  const session = store.sessions.find((item) => item.id === sessionId)
  if (!session || !store.selectedWorkspaceId) return
  $q.dialog({
    title: t('workspacePage.deleteSessionTitle'),
    message: t('workspacePage.deleteSessionConfirm'),
    cancel: true,
    persistent: true,
    color: 'negative',
  }).onOk(() => {
    void store.deleteSession(store.selectedWorkspaceId!, sessionId).catch((err) => {
      $q.notify({
        type: 'negative',
        message: err instanceof Error ? err.message : t('workspacePage.deleteSessionFailed'),
        position: 'top',
      })
    })
  })
}

async function handleRename() {
  if (!renameTarget.value || !store.selectedWorkspaceId) return
  try {
    await store.renameSession(store.selectedWorkspaceId, renameTarget.value.id, renameValue.value.trim())
  } catch (err) {
    console.error('[WorkspacePage] renameSession failed:', err)
    $q.notify({ type: 'negative', message: t('workspacePage.renameFailed'), position: 'top' })
  } finally {
    renameDialogOpen.value = false
  }
}

async function handleCreateSession() {
  if (!store.selectedWorkspaceId) return
  creatingSession.value = true
  try {
    await store.createSession(store.selectedWorkspaceId)
  } catch (e) {
    console.error('[WorkspacePage] createSession failed:', e)
    // Prefer the server's actionable error message (e.g. "agent already running",
    // "workspace archived") falling back to a localized generic label.
    const serverMsg = e instanceof Error ? e.message : null
    $q.notify({
      type: 'negative',
      message: serverMsg ?? t('workspacePage.createSessionFailed'),
      position: 'top',
      timeout: 6000,
    })
  } finally {
    creatingSession.value = false
  }
}

onMounted(() => {
  window.addEventListener('keydown', onWorkspaceShortcut)
  const id = route.params.id as string | undefined
  if (id) {
    store.selectWorkspace(id)
    // Explicit fetch — the `immediate: true` watcher on selectedWorkspaceId
    // above also covers this, but calling it here makes the mount-time
    // hydration independent of that watcher's timing (defense-in-depth).
    void store.fetchPendingWakeup(id)
  }
  const sessionParam = route.query.session as string | undefined
  if (sessionParam) {
    store.selectSession(sessionParam)
  }
})

onUnmounted(() => {
  window.removeEventListener('keydown', onWorkspaceShortcut)
})

watch(
  () => route.params.id,
  (newId) => {
    if (newId && newId !== store.selectedWorkspaceId) {
      store.selectWorkspace(newId as string)
    }
  },
)

// Redirect to the home (workspace list) when the workspace we're viewing
// disappears — happens on archive (manual click, PR-merge auto-archive,
// archive from another tab) or delete. Both flows null `selectedWorkspaceId`
// in the store; we watch that here so every archive source ends up on home.
watch(
  () => store.selectedWorkspaceId,
  (id) => {
    if (id === null && route.params.id) {
      router.push({ name: 'workspace' })
    }
  },
)
</script>

<style lang="scss" scoped>
.wp-header {
  min-height: 48px;
  background-color: var(--kobo-bg-deep);
  border-bottom: 1px solid var(--kobo-border-subtle);
}

.command-palette-card {
  width: min(520px, calc(100vw - 32px));
}

.palette-hint {
  font-family: var(--kobo-font-mono);
  font-size: 11px;
  color: var(--kobo-text-3);
}

.palette-shortcut-hint {
  font-family: var(--kobo-font-mono);
  font-size: 11px;
  color: var(--kobo-text-3);
  background-color: var(--kobo-surface-2);
  border: 1px solid var(--kobo-border-subtle);
  border-radius: var(--kobo-radius-sm);
}

.wp-archived-banner {
  background-color: rgba(255, 255, 255, 0.03);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.wp-purged-banner {
  background-color: rgba(245, 158, 11, 0.08);
  border-bottom: 1px solid rgba(245, 158, 11, 0.18);
}

.wp-pending-prompt-banner {
  background-color: rgba(245, 158, 11, 0.08);
  border-bottom: 1px solid rgba(245, 158, 11, 0.15);
}
</style>
