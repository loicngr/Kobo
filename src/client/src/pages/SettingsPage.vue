<script setup lang="ts">
import { useQuasar } from 'quasar'
import type { ProjectSettings } from 'src/stores/settings'
import { useSettingsStore } from 'src/stores/settings'
import { computed, onMounted, ref, watch } from 'vue'

const $q = useQuasar()
const store = useSettingsStore()

// Tab state
const activeTab = ref('global')

// Global form
const globalModel = ref('auto')
const globalSkipPermissions = ref(true)
const globalPrPrompt = ref('')
const globalGitConventions = ref('')
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
  devServer: { startCommand: '', stopCommand: '' },
})

// Branch fetching for project form
const projectBranches = ref<string[]>([])
const loadingBranches = ref(false)
const savingProject = ref(false)
const deletingProject = ref(false)

// Model options
const modelOptions = [
  { label: 'Auto', value: 'auto' },
  { label: 'Opus 4.6', value: 'claude-opus-4-6' },
  { label: 'Sonnet 4.6', value: 'claude-sonnet-4-6' },
  { label: 'Haiku 4.5', value: 'claude-haiku-4-5-20251001' },
]

const projectModelOptions = [{ label: 'Use global', value: '' }, ...modelOptions]

// Available template variables reference (displayed in the Global tab)
const availableVariables = [
  { name: '{{pr_number}}', description: 'PR number (e.g., 42)' },
  { name: '{{pr_url}}', description: 'Full URL of the created PR' },
  { name: '{{branch_name}}', description: 'Working branch name' },
  { name: '{{source_branch}}', description: 'Source branch the PR targets' },
  { name: '{{workspace_name}}', description: 'Workspace name' },
  { name: '{{project_name}}', description: 'Last segment of the project path' },
  { name: '{{notion_url}}', description: 'Notion URL if set, empty otherwise' },
  { name: '{{commits}}', description: 'Bulleted commit list between source and head' },
  { name: '{{diff_stats}}', description: 'Git shortstat summary (files, insertions, deletions)' },
  { name: '{{tasks}}', description: 'Regular tasks as a checkbox list' },
  { name: '{{acceptance_criteria}}', description: 'Acceptance criteria as a checkbox list' },
]

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
    })
    $q.notify({ type: 'positive', message: 'Global settings saved.', position: 'top' })
  } catch {
    $q.notify({ type: 'negative', message: 'Error saving settings.', position: 'top' })
  } finally {
    savingGlobal.value = false
  }
}

// Save project
async function saveProject() {
  if (!projectForm.value.path.trim()) {
    $q.notify({ type: 'negative', message: 'Project path is required.', position: 'top' })
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
      devServer: projectForm.value.devServer,
    })
    isNewProject.value = false
    // Select the project we just saved
    const idx = store.projects.findIndex((p) => p.path === projectForm.value.path.trim())
    if (idx >= 0) selectedProjectIndex.value = idx
    $q.notify({ type: 'positive', message: 'Project saved.', position: 'top' })
  } catch {
    $q.notify({ type: 'negative', message: 'Error saving project.', position: 'top' })
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
    $q.notify({ type: 'positive', message: 'Project deleted.', position: 'top' })
  } catch {
    $q.notify({ type: 'negative', message: 'Error deleting project.', position: 'top' })
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
</script>

<template>
  <q-page class="settings-page">
    <div class="settings-inner">
      <!-- Header -->
      <div class="settings-header row items-center q-mb-lg">
        <q-icon name="settings" size="24px" color="indigo-4" class="q-mr-sm" />
        <span class="text-h5 text-weight-medium text-grey-3">Settings</span>
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
        <q-tab name="global" label="Global" />
        <q-tab name="projects" label="Projects" />
      </q-tabs>

      <!-- Tab panels -->
      <q-tab-panels v-model="activeTab" animated class="settings-panels">
        <!-- Global tab -->
        <q-tab-panel name="global" class="q-pa-none">
          <div class="settings-card rounded-borders q-pa-lg">
            <div class="text-subtitle1 text-weight-medium q-mb-md text-grey-3">
              Global Settings
            </div>

            <q-separator dark class="q-mb-md" />

            <!-- Model selector -->
            <div class="q-mb-lg">
              <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">Default model</div>
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
              <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">Agent permissions</div>
              <q-toggle
                v-model="globalSkipPermissions"
                label="Skip permission prompts (--dangerously-skip-permissions)"
                dark
                dense
                color="indigo-4"
                class="text-grey-5 text-caption"
              />
              <div class="text-caption text-red-4 q-mt-xs">Warning: disabling this will cause all tool permissions (Write, Edit, Bash...) to be auto-denied in headless mode. The agent will only be able to read.</div>
            </div>

            <!-- Verbose system messages toggle -->
            <div class="q-mb-lg">
              <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">Activity feed</div>
              <q-toggle
                :model-value="store.showVerboseSystemMessages"
                label="Show verbose system messages (task_progress, task_started)"
                dark
                dense
                color="indigo-4"
                class="text-grey-5 text-caption"
                @update:model-value="store.toggleVerboseSystemMessages()"
              />
            </div>

            <!-- Available variables reference -->
            <div class="q-mb-md">
              <q-expansion-item
                dense
                dark
                icon="code"
                label="Available variables in PR prompt template"
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
              <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">PR prompt template</div>
              <q-input
                v-model="globalPrPrompt"
                type="textarea"
                dense
                dark
                outlined
                :rows="8"
                autogrow
                placeholder="Instructions for the agent when creating GitHub PRs..."
                class="settings-input mono-textarea"
              />
              <div class="text-caption text-grey-7 q-mt-xs">Use <code>&#123;&#123;variable&#125;&#125;</code> placeholders. See "Available variables" above.</div>
            </div>

            <!-- Git conventions -->
            <div class="q-mb-lg">
              <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">Git conventions (global)</div>
              <q-input
                v-model="globalGitConventions"
                type="textarea"
                dense
                dark
                outlined
                :rows="8"
                autogrow
                placeholder="# Git conventions..."
                class="settings-input mono-textarea"
              />
              <div class="text-caption text-grey-7 q-mt-xs">These conventions are written to <code>.ai/git-conventions.md</code> in each new workspace and must be followed by the agent before any git operation. Overridden by per-project conventions if defined.</div>
            </div>

            <!-- Save button -->
            <div class="row justify-end">
              <q-btn
                label="Save"
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
                    Configured projects
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
                  No projects configured
                </div>

                <q-separator dark />

                <div class="q-pa-sm">
                  <q-btn
                    label="Add project"
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
                    {{ isNewProject ? 'New project' : 'Edit project' }}
                  </div>

                  <q-separator dark class="q-mb-md" />

                  <!-- Path -->
                  <div class="q-mb-md">
                    <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">Project path</div>
                    <q-input
                      v-model="projectForm.path"
                      dense
                      dark
                      outlined
                      :readonly="!isNewProject"
                      placeholder="/path/to/project"
                      class="settings-input"
                      :class="{ 'readonly-input': !isNewProject }"
                    />
                  </div>

                  <!-- Display name -->
                  <div class="q-mb-md">
                    <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">Display name</div>
                    <q-input
                      v-model="projectForm.displayName"
                      dense
                      dark
                      outlined
                      placeholder="My project"
                      class="settings-input"
                    />
                  </div>

                  <!-- Default source branch -->
                  <div class="q-mb-md">
                    <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">Default source branch</div>
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
                            {{ projectForm.path.trim() ? 'No branches found' : 'Enter the project path' }}
                          </q-item-section>
                        </q-item>
                      </template>
                    </q-select>
                  </div>

                  <!-- Default model -->
                  <div class="q-mb-md">
                    <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">Default model</div>
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
                    <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">Agent permissions</div>
                    <q-toggle
                      v-model="projectForm.dangerouslySkipPermissions"
                      label="Skip permission prompts"
                      dark
                      dense
                      color="indigo-4"
                      class="text-grey-5 text-caption"
                    />
                  </div>

                  <!-- PR prompt template -->
                  <div class="q-mb-md">
                    <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">PR prompt template</div>
                    <q-input
                      v-model="projectForm.prPromptTemplate"
                      type="textarea"
                      dense
                      dark
                      outlined
                      :rows="4"
                      placeholder="Project-specific instructions for PR creation..."
                      class="settings-input mono-textarea"
                    />
                  </div>

                  <!-- Git conventions (project override) -->
                  <div class="q-mb-md">
                    <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">Git conventions (project override)</div>
                    <q-input
                      v-model="projectForm.gitConventions"
                      type="textarea"
                      dense
                      dark
                      outlined
                      :rows="6"
                      autogrow
                      placeholder="Leave empty to use the global conventions."
                      class="settings-input mono-textarea"
                    />
                    <div class="text-caption text-grey-7 q-mt-xs">Leave empty to use the global conventions.</div>
                  </div>

                  <!-- Dev Server -->
                  <div class="q-mb-lg">
                    <div class="field-label text-body2 text-weight-medium q-mb-sm text-grey-6">Dev server</div>
                    <div class="q-mb-md">
                      <div class="field-label-sub text-caption q-mb-xs text-grey-7">Script start</div>
                      <q-input
                        v-model="projectForm.devServer.startCommand"
                        type="textarea"
                        dense
                        dark
                        outlined
                        :rows="3"
                        placeholder="npm run dev"
                        class="settings-input mono-textarea"
                      />
                    </div>
                    <div>
                      <div class="field-label-sub text-caption q-mb-xs text-grey-7">Script stop</div>
                      <q-input
                        v-model="projectForm.devServer.stopCommand"
                        type="textarea"
                        dense
                        dark
                        outlined
                        :rows="3"
                        placeholder="Optional — the process will be killed automatically if empty"
                        class="settings-input mono-textarea"
                      />
                    </div>
                  </div>

                  <!-- Actions -->
                  <div class="row items-center q-gutter-sm">
                    <q-btn
                      v-if="!isNewProject"
                      label="Delete"
                      no-caps
                      flat
                      color="red-5"
                      :loading="deletingProject"
                      @click="deleteProject"
                    />
                    <q-space />
                    <q-btn
                      label="Save"
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
                      Select a project or add a new one
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
