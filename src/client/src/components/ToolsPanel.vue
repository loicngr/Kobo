<template>
  <div class="tools-panel">
    <!-- Dev server section (formerly its own top-tab) -->
    <DevServerPanel :workspace="workspace" />

    <q-separator dark />

    <div class="q-px-md q-py-sm">
      <div class="text-caption text-uppercase text-weight-bold text-kobo-2 q-mb-xs">
        {{ $t('tools.title') }}
      </div>

      <template v-if="!workspace">
        <div class="text-caption text-kobo-3">
          {{ $t('devServer.noWorkspace') }}
        </div>
      </template>

      <template v-else>
      <AutoLoopPanel class="q-mb-md" />

      <ActionAvailability :reason="isArchived ? $t('blockers.archived') : null">
        <EngineSwitchButton :workspace="workspace" @started="revealHandoff" />
      </ActionAvailability>

      <ActionAvailability data-tour="action-availability" :reason="setupBlocker ? $t(setupBlocker === 'configuration' ? 'blockers.setupConfiguration' : `blockers.${setupBlocker}`) : null" :settings="setupBlocker === 'configuration'" settings-tab="scripts">
      <q-btn
        no-caps
        dense
        outline
        color="primary"
        icon="replay"
        :label="$t('tools.runSetupScript')"
        :loading="running"
        :disable="!!setupBlocker"
        class="full-width q-mb-xs"
        @click="runSetupScript"
      >
        <q-tooltip>
          {{ isAgentBusy ? $t('tools.runSetupScriptBusy') : $t('tools.runSetupScriptTooltip') }}
        </q-tooltip>
      </q-btn>
      </ActionAvailability>

      <q-btn
        v-if="hasEditorCommand"
        no-caps
        dense
        outline
        color="primary"
        icon="open_in_new"
        :label="$t('git.openEditor')"
        :loading="openingEditor"
        class="full-width q-mb-xs"
        @click="openEditor"
      />

      <q-btn
        v-if="hasFileManagerCommand"
        no-caps
        dense
        outline
        color="primary"
        icon="folder_open"
        :label="$t('tools.openFileManager')"
        :loading="openingFileManager"
        class="full-width q-mb-xs"
        @click="openFileManager"
      >
        <q-tooltip>{{ $t('tools.openFileManagerTooltip') }}</q-tooltip>
      </q-btn>

      <q-btn
        v-if="hasTerminalCommand"
        no-caps
        dense
        outline
        color="primary"
        icon="terminal"
        :label="$t('tools.openTerminal')"
        :loading="openingTerminal"
        class="full-width q-mb-xs"
        @click="openTerminal"
      >
        <q-tooltip>{{ $t('tools.openTerminalTooltip') }}</q-tooltip>
      </q-btn>

      <ActionAvailability :reason="reviewBlocker ? $t(`blockers.${reviewBlocker}`) : null">
      <q-btn
        no-caps
        dense
        outline
        color="primary"
        icon="rate_review"
        :label="$t('tools.review')"
        :loading="startingReview"
        :disable="!!reviewBlocker"
        class="full-width q-mb-xs"
        @click="reviewDialogOpen = true"
      >
        <q-tooltip>{{ isAgentBusy ? $t('tools.reviewBusy') : $t('tools.reviewTooltip') }}</q-tooltip>
      </q-btn>
      </ActionAvailability>

      <ActionAvailability v-if="hasCiFailure" :reason="ciBlocker ? $t(`blockers.${ciBlocker}`) : null">
      <q-btn
        no-caps
        dense
        unelevated
        color="red-7"
        icon="build_circle"
        :label="$t('tools.fixCi')"
        :loading="fixingCi"
        :disable="!!ciBlocker"
        class="full-width q-mb-xs"
        @click="startCiFix"
      >
        <q-tooltip>{{ $t('tools.fixCiTooltip') }}</q-tooltip>
      </q-btn>
      </ActionAvailability>

      <q-btn
        v-if="workspace?.notionUrl"
        no-caps
        dense
        outline
        color="primary"
        icon="open_in_new"
        :label="$t('tools.openNotion')"
        class="full-width q-mb-xs"
        @click="openExternal(workspace.notionUrl)"
      />
      <q-btn
        v-if="workspace?.sentryUrl"
        no-caps
        dense
        outline
        color="primary"
        icon="open_in_new"
        :label="$t('tools.openSentry')"
        class="full-width q-mb-xs"
        @click="openExternal(workspace.sentryUrl)"
      />

      <div ref="handoffSection" data-tour="ws-session-handoff" class="handoff-section q-mt-sm" :class="{ 'handoff-section--highlighted': handoffHighlighted }">
        <EngineSwitchButton :workspace="workspace" mode="fresh" @started="revealHandoff" />
        <SessionHandoffStatus :workspace-id="workspace.id" @started="revealHandoff" />
      </div>
      </template>
    </div>

    <StartReviewDialog
      v-model="reviewDialogOpen"
      :loading="startingReview"
      :workspace="workspace"
      :current-session="currentSession"
      :can-return-to-session="canReturnToSession"
      @submit="startReview"
    />
  </div>
</template>

<script setup lang="ts">
import { useQuasar } from 'quasar'
import ActionAvailability from 'src/components/ActionAvailability.vue'
import AutoLoopPanel from 'src/components/AutoLoopPanel.vue'
import DevServerPanel from 'src/components/DevServerPanel.vue'
import EngineSwitchButton from 'src/components/EngineSwitchButton.vue'
import SessionHandoffStatus from 'src/components/SessionHandoffStatus.vue'
import StartReviewDialog from 'src/components/StartReviewDialog.vue'
import { useSessionHandoffStore } from 'src/stores/session-handoff'
import { useSettingsStore } from 'src/stores/settings'
import { useWorkspaceStore, type Workspace } from 'src/stores/workspace'
import { getActionBlocker } from 'src/utils/action-blocker'
import { getCurrentSession } from 'src/utils/current-session'
import { isCiFailed } from 'src/utils/pr-status'
import { isBusyStatus } from 'src/utils/workspace-status'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { StartReviewRequest } from '../../../shared/review'

const props = defineProps<{
  workspace: Workspace | null
}>()

const { t } = useI18n()
const $q = useQuasar()
const settingsStore = useSettingsStore()
const workspaceStore = useWorkspaceStore()
const handoffs = useSessionHandoffStore()
const handoffSection = ref<HTMLElement | null>(null)
const handoffHighlighted = ref(false)
let handoffHighlightTimer: ReturnType<typeof setTimeout> | undefined

function clearHandoffHighlight() {
  clearTimeout(handoffHighlightTimer)
  handoffHighlighted.value = false
}

async function revealHandoff(id: string) {
  if (props.workspace?.id !== id) return
  // Wait for the status and any recovery controls to take their final space.
  await nextTick()
  if (props.workspace?.id !== id || !handoffSection.value) return
  const panel = handoffSection.value.closest<HTMLElement>('[data-tour="ws-tab-tools"]')
  if (panel) panel.scrollTop = panel.scrollHeight
  clearHandoffHighlight()
  handoffHighlighted.value = true
  handoffHighlightTimer = setTimeout(clearHandoffHighlight, 3000)
}

watch(() => props.workspace?.id, clearHandoffHighlight)
onBeforeUnmount(clearHandoffHighlight)

const running = ref(false)
const openingEditor = ref(false)
const openingFileManager = ref(false)
const openingTerminal = ref(false)
const reviewDialogOpen = ref(false)
const startingReview = ref(false)
const fixingCi = ref(false)
const currentSession = computed(() => {
  return getCurrentSession(
    workspaceStore.sessions.filter(
      (session) => session.workspaceId === props.workspace?.id && session.status !== 'idle',
    ),
  )
})
const canReturnToSession = computed(() => {
  const current = currentSession.value
  return !!current?.engineSessionId && (!current.engine || current.engine === props.workspace?.engine)
})

const hasCiFailure = computed(() => {
  if (!props.workspace) return false
  const snapshot = workspaceStore.prSnapshots[props.workspace.id]
  return snapshot ? isCiFailed(snapshot) : false
})

const workspaceId = computed(() => props.workspace?.id ?? '')

const hasSetupScript = computed(() => {
  if (!props.workspace) return false
  const project = settingsStore.getProjectByPath(props.workspace.projectPath)
  return !!(project?.setupScript || settingsStore.global.setupScript)
})

const hasEditorCommand = computed(() => !!settingsStore.global.editorCommand)
const hasFileManagerCommand = computed(() => !!settingsStore.global.fileManagerCommand)
const hasTerminalCommand = computed(() => !!settingsStore.global.terminalCommand)

const isAgentBusy = computed(() => isBusyStatus(props.workspace?.status))
const isArchived = computed(() => Boolean(props.workspace?.archivedAt))

const baseBlockerContext = computed(() => ({
  missingWorkspace: !props.workspace,
  purged: !!props.workspace?.worktreePurgedAt,
  archived: isArchived.value,
}))
const setupBlocker = computed(() =>
  getActionBlocker({
    ...baseBlockerContext.value,
    operation: running.value || handoffs.isBlocking(workspaceId.value),
    agentBusy: isAgentBusy.value,
    missingConfiguration: !hasSetupScript.value,
  }),
)
const reviewBlocker = computed(() =>
  getActionBlocker({
    ...baseBlockerContext.value,
    operation: startingReview.value || handoffs.isBlocking(workspaceId.value),
    agentBusy: isAgentBusy.value,
  }),
)
const ciBlocker = computed(() =>
  getActionBlocker({
    ...baseBlockerContext.value,
    operation: fixingCi.value || handoffs.isBlocking(workspaceId.value),
  }),
)

function runSetupScript() {
  if (setupBlocker.value || !workspaceId.value) return
  $q.dialog({
    title: t('tools.runSetupScript'),
    message: t('tools.runSetupScriptConfirm'),
    cancel: true,
    persistent: true,
    dark: true,
  }).onOk(async () => {
    running.value = true
    try {
      const res = await fetch(`/api/workspaces/${workspaceId.value}/run-setup-script`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        $q.notify({
          type: 'negative',
          message: data.error ?? t('tools.setupScriptFailed'),
          position: 'top',
          timeout: 6000,
        })
      } else {
        $q.notify({ type: 'positive', message: t('tools.setupScriptSuccess'), position: 'top', timeout: 3000 })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('tools.setupScriptFailed')
      $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
    } finally {
      running.value = false
    }
  })
}

async function openEditor() {
  if (!workspaceId.value) return
  openingEditor.value = true
  try {
    const res = await fetch(`/api/workspaces/${workspaceId.value}/open-editor`, { method: 'POST' })
    if (!res.ok) {
      const data = await res.json()
      $q.notify({ type: 'negative', message: data.error ?? t('git.openEditorFailed'), position: 'top', timeout: 6000 })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : t('git.openEditorFailed')
    $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
  } finally {
    openingEditor.value = false
  }
}

async function openTerminal() {
  if (!workspaceId.value) return
  openingTerminal.value = true
  try {
    const res = await fetch(`/api/workspaces/${workspaceId.value}/open-terminal`, { method: 'POST' })
    if (!res.ok) {
      const data = await res.json()
      $q.notify({
        type: 'negative',
        message: data.error ?? t('tools.openTerminalFailed'),
        position: 'top',
        timeout: 6000,
      })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : t('tools.openTerminalFailed')
    $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
  } finally {
    openingTerminal.value = false
  }
}

async function openFileManager() {
  if (!workspaceId.value) return
  openingFileManager.value = true
  try {
    const res = await fetch(`/api/workspaces/${workspaceId.value}/open-file-manager`, { method: 'POST' })
    if (!res.ok) {
      const data = await res.json()
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
  } finally {
    openingFileManager.value = false
  }
}

function openExternal(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer')
}

async function startCiFix() {
  if (!workspaceId.value || ciBlocker.value) return
  fixingCi.value = true
  try {
    const res = await fetch(`/api/workspaces/${workspaceId.value}/start-ci-fix`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok) {
      $q.notify({
        type: 'negative',
        message: data.error ?? t('tools.fixCiFailed'),
        position: 'top',
        timeout: 6000,
      })
      return
    }
    $q.notify({ type: 'positive', message: t('tools.fixCiLaunched'), position: 'top', timeout: 3000 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : t('tools.fixCiFailed')
    $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
  } finally {
    fixingCi.value = false
  }
}

async function startReview(payload: StartReviewRequest) {
  if (startingReview.value || reviewBlocker.value || !workspaceId.value) return
  startingReview.value = true
  try {
    const res = await fetch(`/api/workspaces/${workspaceId.value}/start-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = await res.json()
    if (!res.ok) {
      $q.notify({
        type: 'negative',
        message: data.error ?? t('review.failed'),
        position: 'top',
        timeout: 6000,
      })
      return
    }
    $q.notify({ type: 'positive', message: t('review.launched'), position: 'top', timeout: 3000 })
    reviewDialogOpen.value = false
  } catch (err) {
    const msg = err instanceof Error ? err.message : t('review.failed')
    $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
  } finally {
    startingReview.value = false
  }
}
</script>

<style lang="scss" scoped>
.tools-panel {
  min-height: 48px;
}

.handoff-section {
  border-radius: var(--kobo-radius-sm);
  outline: 1px solid transparent;
  outline-offset: var(--kobo-space-xs);
  transition: background-color var(--kobo-duration-short) ease-out, outline-color var(--kobo-duration-short) ease-out;
}

.handoff-section--highlighted {
  background-color: rgba(var(--kobo-accent-rgb), 0.12);
  outline-color: var(--kobo-accent);
}

@media (prefers-reduced-motion: reduce) {
  .handoff-section { transition: none; }
}
</style>
