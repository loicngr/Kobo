<script setup lang="ts">
import { useQuasar } from 'quasar'
import DevServerPanel from 'src/components/DevServerPanel.vue'
import { useSettingsStore } from 'src/stores/settings'
import type { Workspace } from 'src/stores/workspace'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  workspace: Workspace | null
}>()

// Statuses during which the agent is actively working and the setup script
// must NOT be re-run (it would race with the agent's current operations).
const BUSY_STATUSES = ['executing', 'extracting', 'brainstorming'] as const

const { t } = useI18n()
const $q = useQuasar()
const settingsStore = useSettingsStore()

const running = ref(false)
const openingEditor = ref(false)

const workspaceId = computed(() => props.workspace?.id ?? '')

const hasSetupScript = computed(() => {
  if (!props.workspace) return false
  const project = settingsStore.getProjectByPath(props.workspace.projectPath)
  return !!project?.setupScript
})

const hasEditorCommand = computed(() => !!settingsStore.global.editorCommand)

const isAgentBusy = computed(() =>
  props.workspace ? (BUSY_STATUSES as readonly string[]).includes(props.workspace.status) : false,
)

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
</script>

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

        <div v-if="!hasSetupScript" class="text-caption text-grey-8">
          {{ $t('tools.noSetupScript') }}
          <router-link to="/settings" style="color: #6c63ff;">{{ $t('devServer.goToSettings') }}</router-link>
        </div>
      </template>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.tools-panel {
  min-height: 48px;
}
</style>
