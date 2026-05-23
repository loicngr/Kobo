<template>
  <q-page class="column no-wrap" style="height: 100vh;">
    <!-- Header bar -->
    <div class="wp-header row items-center q-px-md q-py-sm no-wrap">
      <template v-if="selectedWs">
        <span class="text-body1 text-weight-medium text-grey-3 ellipsis" style="max-width: 480px;">
          {{ selectedWs.name }}
          <q-tooltip>{{ selectedWs.name }}</q-tooltip>
        </span>
        <q-badge
          :label="statusLabel(selectedWs.status)"
          :color="
            ['error', 'quota'].includes(selectedWs.status) ? 'red-9' :
            selectedWs.status === 'awaiting-user' ? 'amber-9' :
            isBusyStatus(selectedWs.status) ? 'green-9' :
            'grey-8'
          "
          class="q-ml-sm"
          style="font-size: 10px;"
        />
        <AutoLoopChip />
        <q-select
          v-if="sessions.length > 0"
          v-model="selectedSessionId"
          :options="sessionOptions"
          emit-value
          map-options
          dense
          dark
          borderless
          options-dense
          :loading="creatingSession"
          :disable="creatingSession"
          class="q-ml-sm"
          style="min-width: 160px; max-width: 220px; font-size: 11px;"
        >
          <template #option="scope">
            <q-separator v-if="!scope.opt.isSession" spaced />
            <q-item v-bind="scope.itemProps" clickable dense class="row items-center no-wrap">
              <q-item-section>
                <q-item-label :class="!scope.opt.isSession ? 'text-grey-5' : ''">
                  {{ scope.opt.label }}
                </q-item-label>
                <q-item-label v-if="scope.opt.caption" caption>{{ scope.opt.caption }}</q-item-label>
              </q-item-section>
              <q-item-section v-if="scope.opt.isSession" side>
                <q-btn
                  icon="more_vert"
                  flat
                  dense
                  round
                  size="xs"
                  color="grey-6"
                  @click.stop="openRenameDialog(scope.opt.value, scope.opt.label)"
                />
              </q-item-section>
            </q-item>
          </template>
        </q-select>
        <q-space />
        <q-select
          v-model="currentPermissionMode"
          :options="permissionModeOptions"
          emit-value
          map-options
          dense
          dark
          borderless
          options-dense
          class="q-mr-xs"
          style="min-width: 80px; max-width: 140px; font-size: 11px;"
        >
          <template #selected>
            <span class="row items-center no-wrap text-caption text-grey-5">
              <q-icon :name="currentPermissionMode === 'plan' ? 'visibility' : currentPermissionMode === 'strict' ? 'lock' : currentPermissionMode === 'interactive' ? 'security' : 'flash_on'" size="12px" color="amber-6" class="q-mr-xs" />
              {{ permissionModeOptions.find(m => m.value === currentPermissionMode)?.label ?? currentPermissionMode }}
              <q-icon v-if="pendingSpawnChanges.has('agentPermissionMode')" name="schedule" size="11px" color="orange-6" class="q-ml-xs">
                <q-tooltip>{{ $t('workspacePage.pendingNextRun') }}</q-tooltip>
              </q-icon>
            </span>
          </template>
        </q-select>
        <q-select
          v-model="currentModel"
          :options="modelOptions"
          emit-value
          map-options
          dense
          dark
          borderless
          options-dense
          class="q-mr-sm model-select"
          style="min-width: 100px; max-width: 160px; font-size: 11px;"
        >
          <template #selected>
            <span class="row items-center no-wrap text-caption text-grey-5">
              <q-icon name="auto_awesome" size="12px" color="indigo-4" class="q-mr-xs" />
              {{ modelOptions.find(m => m.value === currentModel)?.label ?? currentModel }}
              <q-icon v-if="pendingSpawnChanges.has('model')" name="schedule" size="11px" color="orange-6" class="q-ml-xs">
                <q-tooltip>{{ $t('workspacePage.pendingNextRun') }}</q-tooltip>
              </q-icon>
            </span>
          </template>
        </q-select>
        <q-select
          v-model="currentReasoningEffort"
          :options="reasoningOptions"
          emit-value
          map-options
          dense
          dark
          borderless
          options-dense
          class="q-mr-sm"
          style="min-width: 90px; max-width: 140px; font-size: 11px;"
        >
          <template #selected>
            <span class="row items-center no-wrap text-caption text-grey-5">
              <q-icon name="psychology" size="12px" color="amber-6" class="q-mr-xs" />
              {{ formatReasoningSelectedLabel(currentReasoningEffort) }}
              <q-icon v-if="pendingSpawnChanges.has('reasoningEffort')" name="schedule" size="11px" color="orange-6" class="q-ml-xs">
                <q-tooltip>{{ $t('workspacePage.pendingNextRun') }}</q-tooltip>
              </q-icon>
            </span>
          </template>
        </q-select>
        <q-btn
          v-if="isBusyStatus(selectedWs.status) && !selectedWs.archivedAt"
          dense
          no-caps
          size="sm"
          color="negative"
          icon="stop"
          :label="$t('common.stop')"
          class="q-mr-xs"
          :loading="stopping"
          :disable="stopping"
          @click="handleStop"
        />
      </template>
      <template v-else>
        <span class="text-body2 text-grey-8">
          {{ $t('workspacePage.selectWorkspace') }}
        </span>
      </template>
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
        input-class="text-caption text-grey-5"
        class="workspace-description-input"
        style="width: 100%; max-width: 960px;"
        @blur="saveDescription"
        @keydown.enter.prevent="saveDescription"
      />
      <div
        v-if="selectedWs?.agentDescription"
        class="text-caption text-grey-7 q-mt-xs ellipsis"
        style="font-style: italic; max-width: 960px;"
        :title="t('workspace.agentDescriptionTooltip')"
      >
        {{ selectedWs.agentDescription }}
      </div>
    </div>

    <q-separator dark />

    <div
      v-if="selectedWs?.archivedAt"
      class="wp-archived-banner row items-center q-px-md q-py-sm"
    >
      <q-icon name="inventory_2" size="16px" color="grey-5" class="q-mr-sm" />
      <span class="text-caption text-grey-4">
        {{ $t('workspacePage.archivedBanner') }}
      </span>
      <q-space />
      <q-btn
        flat
        dense
        size="sm"
        no-caps
        color="indigo-4"
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
      <span class="text-caption text-grey-3">
        {{ $t('workspacePage.pendingInitialPromptBanner') }}
      </span>
      <q-space />
      <q-btn
        unelevated
        dense
        size="sm"
        no-caps
        color="indigo-5"
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

    <!-- Activity Feed with Suspense -->
    <Suspense v-if="selectedId">
      <ActivityFeed class="col" style="min-height: 0;" :workspace-id="selectedId" />
      <template #fallback>
        <div class="col column items-center justify-center">
          <q-spinner-dots size="40px" color="indigo-4" />
          <div class="text-grey-6 text-caption q-mt-sm">{{ $t('common.loading') }}</div>
        </div>
      </template>
    </Suspense>

    <AgentBusyBanner />
    <WakeupBanner />
    <AskUserQuestionPanel v-if="selectedId" :workspace-id="selectedId" />
    <PermissionRequestPanel v-if="selectedId" :workspace-id="selectedId" />

    <!-- Chat Input — pinned at bottom -->
    <ChatInput
      v-if="selectedId"
      :workspace-id="selectedId"
    />
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
import { EFFORT_OPTION_DEFS_BY_ENGINE } from 'src/constants/efforts'
import { MODEL_OPTION_DEFS, MODEL_OPTION_DEFS_BY_ENGINE } from 'src/constants/models'
import { PERMISSION_MODES_BY_ENGINE } from 'src/constants/permissionModes'
import type { AgentSession } from 'src/stores/workspace'
import { useWorkspaceStore } from 'src/stores/workspace'
import { useTimeAgo } from 'src/utils/formatters'
import { isBusyStatus } from 'src/utils/workspace-status'
import { computed, defineAsyncComponent, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'

const ActivityFeed = defineAsyncComponent(() =>
  Promise.all([import('src/components/ActivityFeed.vue'), new Promise((resolve) => setTimeout(resolve, 500))]).then(
    ([module]) => module,
  ),
)

import AgentBusyBanner from 'src/components/AgentBusyBanner.vue'
import AgentErrorBanner from 'src/components/AgentErrorBanner.vue'
import AskUserQuestionPanel from 'src/components/AskUserQuestionPanel.vue'
import AutoLoopChip from 'src/components/AutoLoopChip.vue'
import ChatInput from 'src/components/ChatInput.vue'
import PermissionRequestPanel from 'src/components/PermissionRequestPanel.vue'
import QuotaBackoffBanner from 'src/components/QuotaBackoffBanner.vue'
import StaleSessionBanner from 'src/components/StaleSessionBanner.vue'
import WakeupBanner from 'src/components/WakeupBanner.vue'

const $q = useQuasar()
const store = useWorkspaceStore()
const { t } = useI18n()
const { timeAgo } = useTimeAgo()

function statusLabel(status: string): string {
  if (status === 'awaiting-user') return t('workspaceStatus.awaitingUser')
  return status
}

const starting = ref(false)
const stopping = ref(false)
const pendingWorkspaceUpdates = new Set<Promise<unknown>>()

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

function formatReasoningSelectedLabel(value: string): string {
  return reasoningOptions.value.find((r) => r.value === value)?.label ?? value
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
    caption: timeAgo(s.startedAt),
    isSession: true,
  }))
  return [...opts, { label: t('workspacePage.newSession'), value: '__new__', caption: '', isSession: false }]
})

const renameDialogOpen = ref(false)
const renameTarget = ref<{ id: string } | null>(null)
const renameValue = ref('')
const creatingSession = ref(false)

function openRenameDialog(sessionId: string, currentLabel: string) {
  const session = store.sessions.find((s) => s.id === sessionId)
  if (!session) return
  renameTarget.value = { id: sessionId }
  renameValue.value = session.name ?? currentLabel
  renameDialogOpen.value = true
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
  background-color: #16162a;
  border-bottom: 1px solid #2a2a4a;
}

.wp-archived-banner {
  background-color: rgba(255, 255, 255, 0.03);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.wp-pending-prompt-banner {
  background-color: rgba(245, 158, 11, 0.08);
  border-bottom: 1px solid rgba(245, 158, 11, 0.15);
}
</style>
