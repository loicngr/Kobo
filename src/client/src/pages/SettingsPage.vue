<script setup lang="ts">
import { useQuasar } from 'quasar'
import type { ProjectSettings } from 'src/stores/settings'
import { useSettingsStore } from 'src/stores/settings'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const $q = useQuasar()
const store = useSettingsStore()
const { t, locale } = useI18n()

// Tab state
const activeTab = ref('global')

// Global form
const globalModel = ref('auto')
const globalSkipPermissions = ref(true)
const globalPrPrompt = ref('')
const globalGitConventions = ref('')
const globalEditorCommand = ref('')
const globalBrowserNotifications = ref(true)
const globalAudioNotifications = ref(true)
const savingGlobal = ref(false)

// Project form
const selectedProjectIndex = ref(-1)
const isNewProject = ref(false)
const projectForm = ref({
  path: '',
  displayName: '',
  defaultSourceBranch: '',
  defaultModel: '',
  dangerouslySkipPermissions: true,
  prPromptTemplate: '',
  gitConventions: '',
  setupScript: '',
  devServer: { startCommand: '', stopCommand: '' },
})

// Branch fetching for project form
const projectBranches = ref<string[]>([])
const loadingBranches = ref(false)
const savingProject = ref(false)
const deletingProject = ref(false)

// Language options
const languageOptions = [
  { label: 'English', value: 'en' },
  { label: 'Français', value: 'fr' },
  { label: 'Deutsch', value: 'de' },
  { label: 'Español', value: 'es' },
  { label: 'Italiano', value: 'it' },
]

function onLanguageChange(val: string) {
  locale.value = val
  localStorage.setItem('kobo:locale', val)
}

// Model options
const modelOptions = computed(() => [
  { label: t('model.auto'), value: 'auto' },
  { label: t('model.opus'), value: 'claude-opus-4-6' },
  { label: t('model.sonnet'), value: 'claude-sonnet-4-6' },
  { label: t('model.haiku'), value: 'claude-haiku-4-5-20251001' },
])

const projectModelOptions = computed(() => [{ label: t('settings.useGlobal'), value: '' }, ...modelOptions.value])

// Available template variables reference (displayed in the Global tab)
const availableVariables = computed(() => [
  { name: '{{pr_number}}', description: t('settings.var.prNumber') },
  { name: '{{pr_url}}', description: t('settings.var.prUrl') },
  { name: '{{branch_name}}', description: t('settings.var.branchName') },
  { name: '{{source_branch}}', description: t('settings.var.sourceBranch') },
  { name: '{{workspace_name}}', description: t('settings.var.workspaceName') },
  { name: '{{project_name}}', description: t('settings.var.projectName') },
  { name: '{{notion_url}}', description: t('settings.var.notionUrl') },
  { name: '{{commits}}', description: t('settings.var.commits') },
  { name: '{{diff_stats}}', description: t('settings.var.diffStats') },
  { name: '{{tasks}}', description: t('settings.var.tasks') },
  { name: '{{acceptance_criteria}}', description: t('settings.var.acceptanceCriteria') },
])

// Selected project
const selectedProject = computed<ProjectSettings | null>(() => {
  if (selectedProjectIndex.value < 0 || selectedProjectIndex.value >= store.projects.length) {
    return null
  }
  return store.projects[selectedProjectIndex.value] ?? null
})

// Init global form from store
function syncGlobalForm() {
  globalModel.value = store.global.defaultModel
  globalSkipPermissions.value = store.global.dangerouslySkipPermissions ?? true
  globalPrPrompt.value = store.global.prPromptTemplate
  globalGitConventions.value = store.global.gitConventions
  globalEditorCommand.value = store.global.editorCommand ?? ''
  globalBrowserNotifications.value = store.global.browserNotifications ?? true
  globalAudioNotifications.value = store.global.audioNotifications ?? true
}

// Init project form from selected project
function syncProjectForm(project: ProjectSettings | null) {
  if (!project) {
    projectForm.value = {
      path: '',
      displayName: '',
      defaultSourceBranch: '',
      defaultModel: '',
      dangerouslySkipPermissions: true,
      prPromptTemplate: '',
      gitConventions: '',
      setupScript: '',
      devServer: { startCommand: '', stopCommand: '' },
    }
    projectBranches.value = []
    return
  }
  projectForm.value = {
    path: project.path,
    displayName: project.displayName,
    defaultSourceBranch: project.defaultSourceBranch,
    defaultModel: project.defaultModel,
    dangerouslySkipPermissions: project.dangerouslySkipPermissions ?? true,
    prPromptTemplate: project.prPromptTemplate,
    gitConventions: project.gitConventions ?? '',
    setupScript: project.setupScript ?? '',
    devServer: {
      startCommand: project.devServer?.startCommand ?? '',
      stopCommand: project.devServer?.stopCommand ?? '',
    },
  }
  if (project.path) {
    void fetchProjectBranches(project.path)
  }
}

// Fetch branches for project path
async function fetchProjectBranches(path: string) {
  if (!path.trim()) {
    projectBranches.value = []
    return
  }
  loadingBranches.value = true
  try {
    const res = await fetch(`/api/git/branches?path=${encodeURIComponent(path.trim())}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    projectBranches.value = data.local ?? data.branches ?? []
  } catch {
    projectBranches.value = []
  } finally {
    loadingBranches.value = false
  }
}

// Debounce path changes for branch fetching
let pathDebounce: ReturnType<typeof setTimeout> | null = null
watch(
  () => projectForm.value.path,
  (val) => {
    if (pathDebounce) clearTimeout(pathDebounce)
    pathDebounce = setTimeout(() => {
      void fetchProjectBranches(val)
    }, 500)
  },
)

// Watch selected project changes
watch(selectedProjectIndex, () => {
  isNewProject.value = false
  syncProjectForm(selectedProject.value)
})

// Save global settings
async function saveGlobal() {
  savingGlobal.value = true
  try {
    await store.updateGlobal({
      defaultModel: globalModel.value,
      dangerouslySkipPermissions: globalSkipPermissions.value,
      prPromptTemplate: globalPrPrompt.value,
      gitConventions: globalGitConventions.value,
      editorCommand: globalEditorCommand.value,
      browserNotifications: globalBrowserNotifications.value,
      audioNotifications: globalAudioNotifications.value,
    })
    $q.notify({ type: 'positive', message: t('settings.saved'), position: 'top' })
  } catch {
    $q.notify({ type: 'negative', message: t('settings.saveError'), position: 'top' })
  } finally {
    savingGlobal.value = false
  }
}

// Save project
async function saveProject() {
  if (!projectForm.value.path.trim()) {
    $q.notify({ type: 'negative', message: t('settings.projectPathRequired'), position: 'top' })
    return
  }
  savingProject.value = true
  try {
    await store.upsertProject(projectForm.value.path.trim(), {
      displayName: projectForm.value.displayName,
      defaultSourceBranch: projectForm.value.defaultSourceBranch,
      defaultModel: projectForm.value.defaultModel,
      dangerouslySkipPermissions: projectForm.value.dangerouslySkipPermissions,
      prPromptTemplate: projectForm.value.prPromptTemplate,
      gitConventions: projectForm.value.gitConventions,
      setupScript: projectForm.value.setupScript,
      devServer: projectForm.value.devServer,
    })
    isNewProject.value = false
    // Select the project we just saved
    const idx = store.projects.findIndex((p) => p.path === projectForm.value.path.trim())
    if (idx >= 0) selectedProjectIndex.value = idx
    $q.notify({ type: 'positive', message: t('settings.projectSaved'), position: 'top' })
  } catch {
    $q.notify({ type: 'negative', message: t('settings.projectSaveError'), position: 'top' })
  } finally {
    savingProject.value = false
  }
}

// Delete project
async function deleteProject() {
  if (!selectedProject.value) return
  deletingProject.value = true
  try {
    await store.deleteProject(selectedProject.value.path)
    selectedProjectIndex.value = -1
    isNewProject.value = false
    syncProjectForm(null)
    $q.notify({ type: 'positive', message: t('settings.projectDeleted'), position: 'top' })
  } catch {
    $q.notify({ type: 'negative', message: t('settings.projectDeleteError'), position: 'top' })
  } finally {
    deletingProject.value = false
  }
}

// Add new project
function addNewProject() {
  selectedProjectIndex.value = -1
  isNewProject.value = true
  syncProjectForm(null)
}

// Select a project from the list
function selectProject(index: number) {
  isNewProject.value = false
  selectedProjectIndex.value = index
}

// Display name for project list
function projectDisplayName(project: ProjectSettings): string {
  if (project.displayName) return project.displayName
  const parts = project.path.split('/')
  return parts[parts.length - 1] ?? project.path
}

// Branch filter options for q-select
const branchFilterOptions = ref<string[]>([])

function filterBranches(val: string, update: (fn: () => void) => void) {
  update(() => {
    branchFilterOptions.value = val
      ? projectBranches.value.filter((b) => b.toLowerCase().includes(val.toLowerCase()))
      : projectBranches.value
  })
}

// Init
onMounted(async () => {
  await store.fetchSettings()
  syncGlobalForm()
})

// Cleanup debounce timer on unmount
onUnmounted(() => {
  if (pathDebounce) clearTimeout(pathDebounce)
})
</script>

<template>
  <q-page class="settings-page">
    <div class="settings-inner">
      <!-- Header -->
      <div class="settings-header row items-center q-mb-lg">
        <q-icon name="settings" size="24px" color="indigo-4" class="q-mr-sm" />
        <span class="text-h5 text-weight-medium text-grey-3">{{ $t('settings.title') }}</span>
      </div>

      <!-- Tabs -->
      <q-tabs
        v-model="activeTab"
        dense
        active-color="indigo-4"
        indicator-color="indigo-4"
        class="settings-tabs q-mb-lg"
        align="left"
        narrow-indicator
      >
        <q-tab name="global" :label="$t('settings.global')" />
        <q-tab name="projects" :label="$t('settings.projects')" />
      </q-tabs>

      <!-- Tab panels -->
      <q-tab-panels v-model="activeTab" animated class="settings-panels">
        <!-- Global tab -->
        <q-tab-panel name="global" class="q-pa-none">
          <div class="settings-card rounded-borders q-pa-lg">
            <div class="text-subtitle1 text-weight-medium q-mb-md text-grey-3">
              {{ $t('settings.globalSettings') }}
            </div>

            <q-separator dark class="q-mb-md" />

            <!-- Language selector -->
            <div class="q-mb-lg">
              <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">{{ $t('settings.language') }}</div>
              <q-select
                :model-value="locale"
                :options="languageOptions"
                emit-value
                map-options
                option-value="value"
                option-label="label"
                dense
                dark
                outlined
                class="settings-input"
                @update:model-value="onLanguageChange"
              />
            </div>

            <!-- Model selector -->
            <div class="q-mb-lg">
              <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">{{ $t('settings.defaultModel') }}</div>
              <q-select
                v-model="globalModel"
                :options="modelOptions"
                emit-value
                map-options
                option-value="value"
                option-label="label"
                dense
                dark
                outlined
                class="settings-input"
              />
            </div>

            <!-- Skip permissions toggle -->
            <div class="q-mb-lg">
              <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">{{ $t('settings.agentPermissions') }}</div>
              <q-toggle
                v-model="globalSkipPermissions"
                :label="$t('settings.skipPermissions')"
                dark
                dense
                color="indigo-4"
                class="text-grey-5 text-caption"
              />
              <div class="text-caption text-red-4 q-mt-xs">{{ $t('settings.skipPermissionsWarning') }}</div>
            </div>

            <!-- Verbose system messages toggle -->
            <div class="q-mb-lg">
              <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">{{ $t('settings.activityFeed') }}</div>
              <q-toggle
                :model-value="store.showVerboseSystemMessages"
                :label="$t('settings.verboseMessages')"
                dark
                dense
                color="indigo-4"
                class="text-grey-5 text-caption"
                @update:model-value="store.toggleVerboseSystemMessages()"
              />
            </div>

            <!-- Notifications -->
            <div class="q-mb-lg">
              <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">{{ $t('settings.notifications') }}</div>
              <q-toggle
                v-model="globalBrowserNotifications"
                :label="$t('settings.browserNotifications')"
                dark
                dense
                color="indigo-4"
                class="text-grey-5 text-caption"
              />
              <q-toggle
                v-model="globalAudioNotifications"
                :label="$t('settings.audioNotifications')"
                dark
                dense
                color="indigo-4"
                class="text-grey-5 text-caption"
              />
            </div>

            <!-- Available variables reference -->
            <div class="q-mb-md">
              <q-expansion-item
                dense
                dark
                icon="code"
                :label="$t('settings.availableVariables')"
                class="variables-panel rounded-borders"
              >
                <q-list dense dark class="q-pa-sm">
                  <q-item v-for="v in availableVariables" :key="v.name" dense>
                    <q-item-section>
                      <q-item-label class="text-caption" style="font-family: monospace;">{{ v.name }}</q-item-label>
                      <q-item-label caption class="text-grey-7">{{ v.description }}</q-item-label>
                    </q-item-section>
                  </q-item>
                </q-list>
              </q-expansion-item>
            </div>

            <!-- PR prompt template -->
            <div class="q-mb-lg">
              <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">{{ $t('settings.prPromptTemplate') }}</div>
              <q-input
                v-model="globalPrPrompt"
                type="textarea"
                dense
                dark
                outlined
                :rows="8"
                autogrow
                :placeholder="$t('settings.prPromptPlaceholder')"
                class="settings-input mono-textarea"
              />
              <div class="text-caption text-grey-7 q-mt-xs">{{ $t('settings.prPromptHint') }}</div>
            </div>

            <!-- Git conventions -->
            <div class="q-mb-lg">
              <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">{{ $t('settings.gitConventions') }}</div>
              <q-input
                v-model="globalGitConventions"
                type="textarea"
                dense
                dark
                outlined
                :rows="8"
                :placeholder="$t('settings.gitConventionsPlaceholder')"
                class="settings-input mono-textarea"
              />
              <div class="text-caption text-grey-7 q-mt-xs">{{ $t('settings.gitConventionsHint') }}</div>
            </div>

            <div class="q-mb-lg">
              <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">{{ $t('settings.editorCommand') }}</div>
              <q-input
                v-model="globalEditorCommand"
                dense
                dark
                outlined
                :placeholder="$t('settings.editorCommandPlaceholder')"
                class="settings-input"
              />
              <div class="text-caption text-grey-7 q-mt-xs">{{ $t('settings.editorCommandHint') }}</div>
            </div>

            <!-- Save button -->
            <div class="row justify-end">
              <q-btn
                :label="$t('common.save')"
                no-caps
                unelevated
                color="primary"
                :loading="savingGlobal"
                @click="saveGlobal"
              />
            </div>
          </div>
        </q-tab-panel>

        <!-- Projects tab -->
        <q-tab-panel name="projects" class="q-pa-none">
          <div class="row q-gutter-md" style="min-height: 500px;">
            <!-- Left column: project list (30%) -->
            <div class="project-list-col">
              <div class="settings-card rounded-borders" style="height: 100%;">
                <div class="q-pa-sm">
                  <div class="text-caption text-uppercase text-weight-bold q-px-sm q-py-xs text-grey-6" style="letter-spacing: 0.05em;">
                    {{ $t('settings.configuredProjects') }}
                  </div>
                </div>

                <q-separator dark />

                <q-list dark dense class="q-py-xs">
                  <q-item
                    v-for="(project, index) in store.projects"
                    :key="project.path"
                    clickable
                    :active="selectedProjectIndex === index && !isNewProject"
                    active-class="project-item--active"
                    class="project-item q-mx-xs rounded-borders"
                    style="min-height: 40px;"
                    @click="selectProject(index)"
                  >
                    <q-item-section>
                      <q-item-label class="text-body2 text-grey-3">
                        {{ projectDisplayName(project) }}
                      </q-item-label>
                      <q-item-label caption class="text-grey-7 ellipsis" style="font-size: 11px; font-family: monospace;">
                        {{ project.path }}
                      </q-item-label>
                    </q-item-section>
                  </q-item>
                </q-list>

                <!-- Empty state -->
                <div
                  v-if="store.projects.length === 0 && !store.loading"
                  class="q-pa-md text-center text-caption text-grey-8"
                >
                  {{ $t('settings.noProjects') }}
                </div>

                <q-separator dark />

                <div class="q-pa-sm">
                  <q-btn
                    :label="$t('settings.addProject')"
                    icon="add"
                    no-caps
                    flat
                    dense
                    class="full-width"
                    color="indigo-4"
                    @click="addNewProject"
                  />
                </div>
              </div>
            </div>

            <!-- Right column: edit form (70%) -->
            <div class="project-form-col">
              <div class="settings-card rounded-borders q-pa-lg" style="height: 100%;">
                <template v-if="selectedProject || isNewProject">
                  <div class="text-subtitle1 text-weight-medium q-mb-md text-grey-3">
                    {{ isNewProject ? $t('settings.newProject') : $t('settings.editProject') }}
                  </div>

                  <q-separator dark class="q-mb-md" />

                  <!-- Path -->
                  <div class="q-mb-md">
                    <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">{{ $t('settings.projectPath') }}</div>
                    <q-input
                      v-model="projectForm.path"
                      dense
                      dark
                      outlined
                      :readonly="!isNewProject"
                      :placeholder="$t('settings.projectPathPlaceholder')"
                      class="settings-input"
                      :class="{ 'readonly-input': !isNewProject }"
                    />
                  </div>

                  <!-- Display name -->
                  <div class="q-mb-md">
                    <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">{{ $t('settings.displayName') }}</div>
                    <q-input
                      v-model="projectForm.displayName"
                      dense
                      dark
                      outlined
                      :placeholder="$t('settings.displayNamePlaceholder')"
                      class="settings-input"
                    />
                  </div>

                  <!-- Default source branch -->
                  <div class="q-mb-md">
                    <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">{{ $t('settings.defaultSourceBranch') }}</div>
                    <q-select
                      v-model="projectForm.defaultSourceBranch"
                      :options="branchFilterOptions"
                      dense
                      dark
                      outlined
                      use-input
                      emit-value
                      :loading="loadingBranches"
                      class="settings-input"
                      placeholder="main"
                      @filter="filterBranches"
                    >
                      <template #no-option>
                        <q-item>
                          <q-item-section class="text-grey-6 text-caption">
                            {{ projectForm.path.trim() ? $t('createPage.noBranches') : $t('createPage.enterPath') }}
                          </q-item-section>
                        </q-item>
                      </template>
                    </q-select>
                  </div>

                  <!-- Default model -->
                  <div class="q-mb-md">
                    <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">{{ $t('settings.defaultModel.project') }}</div>
                    <q-select
                      v-model="projectForm.defaultModel"
                      :options="projectModelOptions"
                      emit-value
                      map-options
                      option-value="value"
                      option-label="label"
                      dense
                      dark
                      outlined
                      class="settings-input"
                    />
                  </div>

                  <!-- Skip permissions toggle (project override) -->
                  <div class="q-mb-md">
                    <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">{{ $t('settings.agentPermissions') }}</div>
                    <q-toggle
                      v-model="projectForm.dangerouslySkipPermissions"
                      :label="$t('settings.skipPermissions.project')"
                      dark
                      dense
                      color="indigo-4"
                      class="text-grey-5 text-caption"
                    />
                  </div>

                  <!-- PR prompt template -->
                  <div class="q-mb-md">
                    <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">{{ $t('settings.prPromptTemplate.project') }}</div>
                    <q-input
                      v-model="projectForm.prPromptTemplate"
                      type="textarea"
                      dense
                      dark
                      outlined
                      :rows="4"
                      :placeholder="$t('settings.prPromptPlaceholder.project')"
                      class="settings-input mono-textarea"
                    />
                  </div>

                  <!-- Git conventions (project override) -->
                  <div class="q-mb-md">
                    <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">{{ $t('settings.gitConventions.project') }}</div>
                    <q-input
                      v-model="projectForm.gitConventions"
                      type="textarea"
                      dense
                      dark
                      outlined
                      :rows="6"
                      :placeholder="$t('settings.gitConventionsEmpty')"
                      class="settings-input mono-textarea"
                    />
                    <div class="text-caption text-grey-7 q-mt-xs">{{ $t('settings.gitConventionsEmpty') }}</div>
                  </div>

                  <!-- Setup Script -->
                  <div class="q-mb-lg">
                    <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">{{ $t('settings.setupScript') }}</div>
                    <q-input
                      v-model="projectForm.setupScript"
                      type="textarea"
                      dense
                      dark
                      outlined
                      :rows="5"
                      :placeholder="$t('settings.setupScriptPlaceholder')"
                      class="settings-input mono-textarea"
                    />
                    <div class="text-caption text-grey-7 q-mt-xs">{{ $t('settings.setupScriptHint') }}</div>
                  </div>

                  <!-- Dev Server -->
                  <div class="q-mb-lg">
                    <div class="field-label text-body2 text-weight-medium q-mb-sm text-grey-6">{{ $t('settings.devServer') }}</div>
                    <div class="q-mb-md">
                      <div class="field-label-sub text-caption q-mb-xs text-grey-7">{{ $t('settings.devServerStart') }}</div>
                      <q-input
                        v-model="projectForm.devServer.startCommand"
                        type="textarea"
                        dense
                        dark
                        outlined
                        :rows="3"
                        :placeholder="$t('settings.devServerStartPlaceholder')"
                        class="settings-input mono-textarea"
                      />
                    </div>
                    <div>
                      <div class="field-label-sub text-caption q-mb-xs text-grey-7">{{ $t('settings.devServerStop') }}</div>
                      <q-input
                        v-model="projectForm.devServer.stopCommand"
                        type="textarea"
                        dense
                        dark
                        outlined
                        :rows="3"
                        :placeholder="$t('settings.devServerStopPlaceholder')"
                        class="settings-input mono-textarea"
                      />
                    </div>
                  </div>

                  <!-- Actions -->
                  <div class="row items-center q-gutter-sm">
                    <q-btn
                      v-if="!isNewProject"
                      :label="$t('common.delete')"
                      no-caps
                      flat
                      color="red-5"
                      :loading="deletingProject"
                      @click="deleteProject"
                    />
                    <q-space />
                    <q-btn
                      :label="$t('common.save')"
                      no-caps
                      unelevated
                      color="primary"
                      :loading="savingProject"
                      @click="saveProject"
                    />
                  </div>
                </template>

                <!-- No selection state -->
                <template v-else>
                  <div class="column items-center justify-center" style="height: 100%; min-height: 300px;">
                    <q-icon name="folder_open" size="48px" color="grey-7" class="q-mb-md" />
                    <div class="text-body2 text-grey-8">
                      {{ $t('settings.selectProject') }}
                    </div>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </q-tab-panel>
      </q-tab-panels>
    </div>
  </q-page>
</template>

<style lang="scss" scoped>
.settings-page {
  background-color: #1a1a2e;
  min-height: 100%;
  padding: 32px 24px;
}

.settings-inner {
  width: 100%;
  max-width: 900px;
  margin: 0 auto;
}

.settings-header {
  min-height: 48px;
}

.settings-tabs {
  :deep(.q-tab) {
    color: #888;
    text-transform: none;
    font-weight: 500;
  }

  :deep(.q-tab--active) {
    color: #6c63ff;
  }
}

.settings-panels {
  background: transparent;
}

.settings-card {
  background: #222244;
  border: 1px solid #2a2a4a;
}

// field-label: font-size and font-weight moved to template (text-body2 text-weight-medium)

// field-label-sub: font-size moved to template (text-caption)

.settings-input {
  :deep(.q-field__control) {
    background: #1a1a2e;
    border-color: #2a2a4a;
  }

  :deep(.q-field__native),
  :deep(input),
  :deep(textarea) {
    color: #e0e0e0;
  }

  :deep(.q-field__label) {
    color: #888;
  }
}

.mono-textarea {
  :deep(textarea) {
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 13px;
  }
}

.readonly-input {
  :deep(.q-field__control) {
    background: #16162a;
  }

  :deep(input) {
    color: #888;
  }
}

.project-list-col {
  width: 30%;
  min-width: 200px;
  max-width: 280px;
  flex-shrink: 0;
  overflow: hidden;
}

.project-form-col {
  flex: 1;
  min-width: 0;
}

.project-item {
  &:hover {
    background-color: rgba(255, 255, 255, 0.03);
  }
}

.project-item--active {
  background-color: #2a2a4a !important;
  border-left: 3px solid #6c63ff;
}
</style>
