<template>
  <div class="tools-panel">
    <!-- Dev server section (formerly its own top-tab) -->
    <DevServerPanel :workspace="workspace" />

    <q-separator dark />

    <div class="q-px-md q-py-sm">
      <div class="text-caption text-uppercase text-weight-bold text-grey-5 q-mb-xs">
        {{ $t('tools.title') }}
      </div>

      <template v-if="!workspace">
        <div class="text-caption text-grey-8">
          {{ $t('devServer.noWorkspace') }}
        </div>
      </template>

      <template v-else>
      <AutoLoopPanel class="q-mb-md" />

      <q-btn
        no-caps
        dense
        outline
        color="indigo-4"
        icon="replay"
        :label="$t('tools.runSetupScript')"
        :loading="running"
        :disable="!hasSetupScript || running || isAgentBusy"
        class="full-width q-mb-xs"
        @click="runSetupScript"
      >
        <q-tooltip>
          {{ isAgentBusy ? $t('tools.runSetupScriptBusy') : $t('tools.runSetupScriptTooltip') }}
        </q-tooltip>
      </q-btn>

      <q-btn
        v-if="hasEditorCommand"
        no-caps
        dense
        outline
        color="indigo-4"
        icon="open_in_new"
        :label="$t('git.openEditor')"
        :loading="openingEditor"
        class="full-width q-mb-xs"
        @click="openEditor"
      />

      <q-btn
        no-caps
        dense
        outline
        color="indigo-4"
        icon="rate_review"
        :label="$t('tools.review')"
        :loading="startingReview"
        :disable="!workspace || isAgentBusy"
        class="full-width q-mb-xs"
        @click="reviewDialogOpen = true"
      >
        <q-tooltip>{{ isAgentBusy ? $t('tools.reviewBusy') : $t('tools.reviewTooltip') }}</q-tooltip>
      </q-btn>

      <q-btn
        v-if="workspace?.notionUrl"
        no-caps
        dense
        outline
        color="indigo-4"
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
        color="indigo-4"
        icon="open_in_new"
        :label="$t('tools.openSentry')"
        class="full-width q-mb-xs"
        @click="openExternal(workspace.sentryUrl)"
      />

        <div v-if="!hasSetupScript" class="text-caption text-grey-8">
          {{ $t('tools.noSetupScript') }}
          <router-link to="/settings" style="color: #6c63ff;">{{ $t('devServer.goToSettings') }}</router-link>
        </div>

      </template>
    </div>

    <StartReviewDialog
      v-model="reviewDialogOpen"
      :loading="startingReview"
      @submit="startReview"
    />
  </div>
</template>

<script setup lang="ts">
import { useQuasar } from 'quasar'
import AutoLoopPanel from 'src/components/AutoLoopPanel.vue'
import DevServerPanel from 'src/components/DevServerPanel.vue'
import StartReviewDialog from 'src/components/StartReviewDialog.vue'
import { useSettingsStore } from 'src/stores/settings'
import type { Workspace } from 'src/stores/workspace'
import { isBusyStatus } from 'src/utils/workspace-status'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  workspace: Workspace | null
}>()

const { t } = useI18n()
const $q = useQuasar()
const settingsStore = useSettingsStore()

const running = ref(false)
const openingEditor = ref(false)
const reviewDialogOpen = ref(false)
const startingReview = ref(false)

const workspaceId = computed(() => props.workspace?.id ?? '')

const hasSetupScript = computed(() => {
  if (!props.workspace) return false
  const project = settingsStore.getProjectByPath(props.workspace.projectPath)
  return !!project?.setupScript
})

const hasEditorCommand = computed(() => !!settingsStore.global.editorCommand)

const isAgentBusy = computed(() => isBusyStatus(props.workspace?.status))

function runSetupScript() {
  if (!workspaceId.value) return
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

function openExternal(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer')
}

async function startReview(payload: { additionalInstructions: string; newSession: boolean }) {
  if (!workspaceId.value) return
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
</style>
