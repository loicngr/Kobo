<script setup lang="ts">
import { useQuasar } from 'quasar'
import { useSettingsStore } from 'src/stores/settings'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  workspace: { id: string; projectPath: string; workingBranch: string } | null
}>()

const { t } = useI18n()
const $q = useQuasar()
const settingsStore = useSettingsStore()

const running = ref(false)

const workspaceId = computed(() => props.workspace?.id ?? '')

const hasSetupScript = computed(() => {
  if (!props.workspace) return false
  const project = settingsStore.getProjectByPath(props.workspace.projectPath)
  return !!project?.setupScript
})

async function runSetupScript() {
  if (!workspaceId.value) return
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
}
</script>

<template>
  <div class="tools-panel q-px-md q-py-sm">
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
        :disable="!hasSetupScript || running"
        class="full-width q-mb-xs"
        @click="runSetupScript"
      >
        <q-tooltip>{{ $t('tools.runSetupScriptTooltip') }}</q-tooltip>
      </q-btn>

      <div v-if="!hasSetupScript" class="text-caption text-grey-8">
        {{ $t('tools.noSetupScript') }}
        <router-link to="/settings" style="color: #6c63ff;">{{ $t('devServer.goToSettings') }}</router-link>
      </div>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.tools-panel {
  min-height: 48px;
}
</style>
