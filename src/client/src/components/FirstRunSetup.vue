<template>
  <section v-if="visible" data-test="first-run" class="first-run" aria-labelledby="first-run-title">
    <h2 id="first-run-title" class="text-h6">{{ $t('setup.title') }}</h2>
    <p>{{ $t('setup.intro') }}</p>
    <div class="row q-col-gutter-md">
      <q-select v-model="engine" class="col-12 col-sm-4" outlined emit-value map-options :disable="saving"
        :options="[{ label: 'Claude Code', value: 'claude-code' }, { label: 'OpenAI Codex', value: 'codex' }]"
        :label="$t('engine.select')" />
      <div class="col-12 col-sm-8">
        <div class="row items-center no-wrap q-gutter-x-sm">
          <q-input v-model="projectPath" class="col" outlined :disable="saving" :label="$t('setup.project')" />
          <q-btn flat no-caps :label="$t('folderPicker.title')" :disable="saving" @click="picker = true" />
        </div>
      </div>
    </div>
    <p class="q-mt-md">{{ $t('setup.credentials') }}</p>
    <p class="text-caption">{{ $t('setup.permissions') }}</p>
    <div class="row q-gutter-sm">
      <q-btn data-test="check" outline no-caps :label="$t('setup.check')" :loading="checking" :disable="saving" @click="check" />
    </div>
    <p v-if="error" role="alert" class="text-negative">{{ $t('setup.failed') }}</p>
    <ul v-if="report" aria-live="polite">
      <li v-for="item in report.checks" :key="item.code">
        {{ $t(`setup.check.${item.code}`) }} — {{ $t(`setup.status.${item.status}`) }}
        <span v-if="item.status !== 'ok'">. {{ $t(`setup.fix.${item.code}`) }}</span>
      </li>
    </ul>
    <div class="row q-gutter-sm q-mt-md">
      <q-btn data-test="start" no-caps color="primary" :label="$t('setup.start')" :loading="saving"
        :disable="!canStart" @click="start" />
      <q-btn flat no-caps :label="$t('setup.settings')" :to="{ name: 'settings' }" />
      <q-btn flat no-caps :label="$t('setup.skip')" :disable="saving" @click="dismiss" />
    </div>
    <FolderPickerDialog v-model="picker" :initial-path="projectPath" @select="projectPath = $event" />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { isNavigationFailure, NavigationFailureType, useRouter } from 'vue-router'
import type { EnvironmentReport } from '../../../shared/environment'
import { useSettingsStore } from '../stores/settings'
import { apiFetch } from '../utils/api'
import FolderPickerDialog from './FolderPickerDialog.vue'

const settings = useSettingsStore()
const router = useRouter()
const reopened = ref(false)
const engine = ref<EnvironmentReport['engine']>('claude-code')
const projectPath = ref('')
const picker = ref(false)
const checking = ref(false)
const saving = ref(false)
const error = ref(false)
const report = ref<EnvironmentReport | null>(null)
const visible = computed(() => settings.loaded && (reopened.value || !settings.global.onboardingComplete))
const canStart = computed(
  () =>
    !!projectPath.value.trim() &&
    !!report.value &&
    !checking.value &&
    !report.value.checks.some((c) => c.status === 'error' || c.status === 'missing'),
)
let requestVersion = 0
watch([engine, projectPath], () => {
  requestVersion++
  report.value = null
  error.value = false
})

async function check() {
  const version = ++requestVersion
  checking.value = true
  error.value = false
  report.value = null
  try {
    const query = new URLSearchParams({ engine: engine.value, projectPath: projectPath.value.trim() })
    const result = await apiFetch<EnvironmentReport>(`/api/environment?${query}`, { timeoutMs: 15_000 })
    if (version === requestVersion) report.value = result
  } catch {
    if (version === requestVersion) error.value = true
  } finally {
    checking.value = false
  }
}

async function dismiss() {
  saving.value = true
  error.value = false
  try {
    await settings.updateGlobal({ onboardingComplete: true })
    reopened.value = false
  } catch {
    error.value = true
  } finally {
    saving.value = false
  }
}

async function start() {
  if (!canStart.value || saving.value) return
  saving.value = true
  error.value = false
  try {
    const project = projectPath.value.trim()
    const selectedEngine = engine.value
    if (!settings.getProjectByPath(project)) await settings.upsertProject(project, {})
    const setupRequest = Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) => value.toString(16)).join('-')
    const failure = await router.push({ name: 'create', query: { engine: selectedEngine, project, setupRequest } })
    if (failure && !isNavigationFailure(failure, NavigationFailureType.duplicated))
      throw new Error('Navigation did not complete')
    await settings.updateGlobal({ onboardingComplete: true })
    reopened.value = false
  } catch {
    reopened.value = true
    error.value = true
  } finally {
    saving.value = false
  }
}

function reopen() {
  reopened.value = true
}
onMounted(() => window.addEventListener('kobo:setup', reopen))
onUnmounted(() => {
  requestVersion++
  window.removeEventListener('kobo:setup', reopen)
})
</script>

<style scoped>
.first-run {
  padding: var(--kobo-space-xl);
  border-bottom: 1px solid var(--kobo-border);
  background: var(--kobo-surface);
}
</style>
