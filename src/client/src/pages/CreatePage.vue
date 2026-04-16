<script setup lang="ts">
import { useQuasar } from 'quasar'
import { MODEL_OPTION_DEFS } from 'src/constants/models'
import { useSettingsStore } from 'src/stores/settings'
import { useWebSocketStore } from 'src/stores/websocket'
import { useWorkspaceStore } from 'src/stores/workspace'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

const router = useRouter()
const $q = useQuasar()
const store = useWorkspaceStore()
const settingsStore = useSettingsStore()
const { t } = useI18n()

const pathFilterOptions = ref<string[]>([])

// Form fields
const workspaceName = ref('')
const description = ref('')
const notionUrl = ref('')
const useNotion = ref(false)
const model = ref('auto')
const reasoningEffort = ref('auto')
const projectPath = ref('')
const branch = ref<string | null>(null)
const branchType = ref('feature')
const skipSetupScript = ref(false)

const branchTypeOptions = [
  { label: 'feature/', value: 'feature' },
  { label: 'fix/', value: 'fix' },
  { label: 'hotfix/', value: 'hotfix' },
  { label: 'chore/', value: 'chore' },
  { label: 'refactor/', value: 'refactor' },
  { label: 'docs/', value: 'docs' },
  { label: 'test/', value: 'test' },
]
const permissionMode = ref(settingsStore.global.defaultPermissionMode || 'plan')

// State
const branches = ref<string[]>([])
const loadingBranches = ref(false)
const submitting = ref(false)

// Model options — Claude Code Max
const modelOptions = computed(() => [
  ...MODEL_OPTION_DEFS.map((option) => ({
    label: t(option.i18nLabelKey),
    value: option.value,
    description: t(option.i18nDescriptionKey),
  })),
])

function formatReasoningLabel(label: string): string {
  const separatorIndex = label.indexOf(':')
  if (separatorIndex >= 0) return label.slice(separatorIndex + 1).trim()
  return label
}

const reasoningOptions = computed(() => [
  { label: formatReasoningLabel(t('reasoning.auto')), value: 'auto', description: t('reasoning.autoDescription') },
  { label: formatReasoningLabel(t('reasoning.low')), value: 'low', description: t('reasoning.lowDescription') },
  {
    label: formatReasoningLabel(t('reasoning.medium')),
    value: 'medium',
    description: t('reasoning.mediumDescription'),
  },
  { label: formatReasoningLabel(t('reasoning.high')), value: 'high', description: t('reasoning.highDescription') },
  { label: formatReasoningLabel(t('reasoning.max')), value: 'max', description: t('reasoning.maxDescription') },
])

// Validate Notion URL
const isValidNotionUrl = computed(() => notionUrl.value.trim().startsWith('https://www.notion.so/'))

// Manual tasks / criteria (when no Notion ticket)
const manualTasks = ref<string[]>([])
const manualCriteria = ref<string[]>([])
const newManualTask = ref('')
const newManualCriterion = ref('')

const showManualSections = computed(() => {
  return !useNotion.value || !isValidNotionUrl.value
})

function addManualTask() {
  const trimmed = newManualTask.value.trim()
  if (!trimmed) return
  manualTasks.value.push(trimmed)
  newManualTask.value = ''
}

function removeManualTask(idx: number) {
  manualTasks.value.splice(idx, 1)
}

function addManualCriterion() {
  const trimmed = newManualCriterion.value.trim()
  if (!trimmed) return
  manualCriteria.value.push(trimmed)
  newManualCriterion.value = ''
}

function removeManualCriterion(idx: number) {
  manualCriteria.value.splice(idx, 1)
}

function toggleNotion() {
  useNotion.value = !useNotion.value
  if (!useNotion.value) notionUrl.value = ''
}

const useSentry = ref(false)
const sentryUrl = ref('')
const isValidSentryUrl = computed(() => /\/issues\/\d+/.test(sentryUrl.value.trim()))

function toggleSentry() {
  useSentry.value = !useSentry.value
  if (!useSentry.value) sentryUrl.value = ''
}

// Fetch branches when project path changes
async function fetchBranches(path: string) {
  if (!path.trim()) {
    branches.value = []
    branch.value = null
    return
  }
  loadingBranches.value = true
  try {
    const res = await fetch(`/api/git/branches?path=${encodeURIComponent(path.trim())}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    branches.value = data.local ?? data.branches ?? []
    if (branches.value.length > 0 && !branch.value) {
      branch.value = branches.value[0] ?? null
    }
  } catch {
    branches.value = []
    branch.value = null
  } finally {
    loadingBranches.value = false
  }
}

// Auto-fill from settings when a known project is selected
function applyProjectDefaults(path: string) {
  const project = settingsStore.getProjectByPath(path)
  if (project) {
    if (project.defaultSourceBranch) {
      branch.value = project.defaultSourceBranch
    }
    if (project.defaultModel) {
      model.value = project.defaultModel
    } else if (settingsStore.global.defaultModel) {
      model.value = settingsStore.global.defaultModel
    }
  }
}

// Debounce for project path input
let pathDebounce: ReturnType<typeof setTimeout> | null = null
watch(projectPath, (val) => {
  if (pathDebounce) clearTimeout(pathDebounce)
  pathDebounce = setTimeout(() => {
    branch.value = null
    void fetchBranches(val)
    applyProjectDefaults(val)
  }, 500)
})

// Filter project paths for the q-select
function filterProjectPaths(val: string, update: (fn: () => void) => void) {
  update(() => {
    pathFilterOptions.value = settingsStore.projectPaths.filter((p) => p.toLowerCase().includes(val.toLowerCase()))
  })
}

// Fetch settings on mount
onMounted(() => {
  settingsStore.fetchSettings()
})

// Cleanup debounce timer on unmount
onUnmounted(() => {
  if (pathDebounce) clearTimeout(pathDebounce)
})

// Convert text to kebab-case feature branch name.
// Strips diacritics via NFD decomposition before removing non-ASCII so that
// accented letters (é→e, è→e, ç→c, etc.) are preserved rather than dropped.
function toKebabCase(str: string): string {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 50)
}

// No client-side name extraction from Notion URL slugs — they lose accents and
// produce unreadable text. The server extracts the real title (with accents) via
// the Notion API after workspace creation and updates the name automatically.

// Get the final workspace name
function getFinalName(): string {
  if (workspaceName.value.trim()) return workspaceName.value.trim().substring(0, 80)
  if (!useNotion.value && description.value.trim()) {
    const firstLine = description.value.trim().split('\n')[0] ?? ''
    return firstLine.substring(0, 80) || 'workspace'
  }
  return 'workspace'
}

// Extract a branch-safe name from a Notion URL slug.
// If the slug contains a ticket ID (TK-XXXX), it is placed first so the branch
// name becomes "TK-1122--rest-of-slug", making it easy to trace in git.
function branchNameFromNotionUrl(url: string): string {
  const lastSegment = url.split('/').pop() ?? ''
  const parts = lastSegment.split('-')
  // Remove the 32-char hex ID at the end
  if (parts.length > 1 && /^[0-9a-f]{12,}$/i.test(parts[parts.length - 1])) {
    parts.pop()
  }
  const raw = parts.join('-').toLowerCase()

  // Extract ticket ID (TK-XXXX) anywhere in the slug
  const ticketMatch = raw.match(/tk-(\d+)/)
  if (ticketMatch) {
    const ticketId = `TK-${ticketMatch[1]}`
    // Remove the ticket ID from the slug and clean up
    const rest = raw
      .replace(/tk-\d+/i, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 40)
    return rest ? `${ticketId}--${rest}` : ticketId
  }

  return raw.substring(0, 50) || `task-${Date.now()}`
}

// Form validation
function validate(): string | null {
  if (useNotion.value && !isValidNotionUrl.value) return t('createPage.validationNotionUrl')
  if (useSentry.value && !isValidSentryUrl.value) return t('createPage.sentryValidation')
  // Description is optional when Notion or Sentry provides the workspace context
  if (!useNotion.value && !useSentry.value && !description.value.trim()) {
    return t('createPage.validationDescription')
  }
  if (!useNotion.value && !useSentry.value && (!getFinalName() || getFinalName() === 'workspace')) {
    if (!workspaceName.value.trim() && !description.value.trim()) return t('createPage.validationName')
  }
  if (!projectPath.value.trim()) return t('createPage.validationPath')
  if (!branch.value) return t('createPage.validationBranch')
  return null
}

// Submit form
async function handleCreate() {
  const error = validate()
  if (error) {
    $q.notify({ type: 'negative', message: error, position: 'top' })
    return
  }

  submitting.value = true
  try {
    const name = getFinalName()

    // Generate branch name.
    // When a Notion URL is present, always derive the slug from it so the
    // ticket ID (TK-XXXX) appears in the branch name even if the workspace
    // name was typed manually. Falls back to the workspace name, then a
    // timestamp when neither source is available.
    let branchSlug: string
    if (useNotion.value && isValidNotionUrl.value) {
      branchSlug = branchNameFromNotionUrl(notionUrl.value.trim())
    } else if (name !== 'workspace') {
      branchSlug = toKebabCase(name)
    } else {
      branchSlug = `task-${Date.now()}`
    }
    const workingBranch = `${branchType.value}/${branchSlug}`

    const payload = {
      name,
      projectPath: projectPath.value.trim(),
      sourceBranch: branch.value as string,
      workingBranch,
      model: model.value,
      reasoningEffort: reasoningEffort.value,
      ...(useNotion.value && isValidNotionUrl.value ? { notionUrl: notionUrl.value.trim() } : {}),
      ...(useSentry.value && isValidSentryUrl.value ? { sentryUrl: sentryUrl.value.trim() } : {}),
      ...(showManualSections.value && manualTasks.value.length > 0 ? { tasks: manualTasks.value } : {}),
      ...(showManualSections.value && manualCriteria.value.length > 0
        ? { acceptanceCriteria: manualCriteria.value }
        : {}),
      ...(skipSetupScript.value ? { skipSetupScript: true } : {}),
      ...(description.value.trim() ? { description: description.value.trim() } : {}),
      permissionMode: permissionMode.value,
    }

    const workspace = await store.createWorkspace(payload)
    // Subscribe to receive WebSocket events for this workspace
    const wsStore = useWebSocketStore()
    wsStore.subscribe(workspace.id)
    store.selectWorkspace(workspace.id)
    void router.push({ name: 'workspace', params: { id: workspace.id } })
  } catch {
    $q.notify({
      type: 'negative',
      message: t('createPage.errorCreating'),
      position: 'top',
    })
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <q-page class="create-page flex flex-center column">
    <div class="create-inner">
      <!-- Title -->
      <div class="create-title text-center text-weight-bold q-mb-lg text-grey-3">
        {{ $t('createPage.title') }}
      </div>

      <!-- Input card -->
      <div class="create-card rounded-borders">
        <!-- Top bar: model badge + Notion toggle -->
        <div class="card-top-bar row items-center q-px-md q-py-xs">
          <span class="model-badge cursor-default row items-center q-gutter-xs">
            <q-icon name="auto_awesome" size="14px" color="indigo-4" />
            <span class="text-indigo-3 text-weight-medium text-caption">{{ $t('createPage.claudeCode') }}</span>
          </span>
          <q-space />
          <q-btn
            flat
            dense
            no-caps
            size="sm"
            :color="useNotion ? 'green-4' : 'grey-5'"
            class="notion-toggle-btn text-caption rounded-borders"
            @click="toggleNotion"
          >
            <q-icon name="description" size="14px" class="q-mr-xs" />
            {{ useNotion ? $t('createPage.notionEnabled') : $t('createPage.importNotion') }}
          </q-btn>
          <q-btn
            flat
            dense
            no-caps
            size="sm"
            :color="useSentry ? 'red-4' : 'grey-5'"
            class="sentry-toggle-btn text-caption rounded-borders q-ml-sm"
            @click="toggleSentry"
          >
            <q-icon name="bug_report" size="14px" class="q-mr-xs" />
            {{ useSentry ? $t('createPage.sentryEnabled') : $t('createPage.importSentry') }}
          </q-btn>
        </div>

        <q-separator color="grey-9" />

        <!-- Notion URL input (when toggled) -->
        <transition name="slide">
          <div v-if="useNotion" class="notion-url-wrap">
            <q-input
              v-model="notionUrl"
              borderless
              dense
              :placeholder="$t('createPage.notionPlaceholder')"
              class="notion-url-input"
              input-class="notion-url-input-inner"
            >
              <template #prepend>
                <q-icon name="link" size="16px" :color="isValidNotionUrl ? 'green-4' : 'grey-6'" />
              </template>
            </q-input>
            <div v-if="notionUrl.trim() && !isValidNotionUrl" class="notion-error text-caption q-px-md q-pb-xs text-red-5">
              {{ $t('createPage.notionValidation') }}
            </div>
            <div v-if="isValidNotionUrl" class="notion-valid text-caption q-px-md q-pb-xs text-green-4">
              {{ $t('createPage.notionAutoExtract') }}
            </div>
          </div>
        </transition>

        <q-separator v-if="useNotion" color="grey-9" />

        <!-- Sentry URL input (when toggled) -->
        <transition name="slide">
          <div v-if="useSentry" class="sentry-url-wrap">
            <q-input
              v-model="sentryUrl"
              borderless
              dense
              :placeholder="$t('createPage.sentryPlaceholder')"
              class="sentry-url-input"
              input-class="sentry-url-input-inner"
            >
              <template #prepend>
                <q-icon name="link" size="16px" :color="isValidSentryUrl ? 'red-4' : 'grey-6'" />
              </template>
            </q-input>
            <div v-if="sentryUrl.trim() && !isValidSentryUrl" class="sentry-error text-caption q-px-md q-pb-xs text-red-5">
              {{ $t('createPage.sentryValidation') }}
            </div>
            <div v-if="isValidSentryUrl" class="sentry-valid text-caption q-px-md q-pb-xs text-red-4">
              {{ $t('createPage.sentryAutoExtract') }}
            </div>
          </div>
        </transition>

        <q-separator v-if="useSentry" color="grey-9" />

        <!-- Workspace name -->
        <div class="card-name-wrap">
          <q-input
            v-model="workspaceName"
            borderless
            dense
            :placeholder="useNotion && isValidNotionUrl ? $t('createPage.workspaceName') : $t('createPage.workspaceNamePlaceholder')"
            class="name-input"
            input-class="name-input-inner"
          />
        </div>

        <q-separator color="grey-9" />

        <!-- Textarea (description / additional instructions) -->
        <div class="card-textarea-wrap">
          <q-input
            v-model="description"
            type="textarea"
            borderless
            autogrow
            :rows="3"
            :placeholder="useNotion ? $t('createPage.instructions') : $t('createPage.instructionsPlaceholder')"
            class="create-textarea"
            input-class="create-textarea-input"
            @keydown.ctrl.enter="handleCreate"
            @keydown.meta.enter="handleCreate"
          />
        </div>

        <q-separator color="grey-9" />

        <!-- Manual tasks / criteria (when no Notion ticket) -->
        <template v-if="showManualSections">
          <div class="manual-hint q-px-md q-py-sm text-caption text-grey-6">
            {{ $t('createPage.manualHint') }}
          </div>

          <q-expansion-item
            dark
            dense
            :label="$t('createPage.tasks', { count: manualTasks.length })"
            header-class="text-grey-4 manual-expansion-header"
            class="manual-expansion q-mx-sm"
          >
            <div class="q-pa-sm manual-section-body">
              <div class="row items-center q-gutter-sm q-mb-sm">
                <q-input
                  v-model="newManualTask"
                  dark
                  dense
                  borderless
                  :placeholder="$t('createPage.addTask')"
                  class="col manual-input"
                  input-class="manual-input-inner"
                  @keydown.enter.prevent="addManualTask"
                />
                <q-btn
                  flat
                  dense
                  round
                  icon="add"
                  color="indigo-4"
                  :disable="!newManualTask.trim()"
                  @click="addManualTask"
                >
                  <q-tooltip>{{ $t('tooltip.addTask') }}</q-tooltip>
                </q-btn>
              </div>
              <div
                v-for="(task, idx) in manualTasks"
                :key="`task-${idx}`"
                class="row items-center q-py-xs manual-item"
              >
                <span class="col text-caption text-grey-4">{{ task }}</span>
                <q-btn
                  flat
                  dense
                  round
                  icon="close"
                  size="xs"
                  color="grey-6"
                  @click="removeManualTask(idx)"
                >
                  <q-tooltip>{{ $t('tooltip.removeTask') }}</q-tooltip>
                </q-btn>
              </div>
            </div>
          </q-expansion-item>

          <q-expansion-item
            dark
            dense
            :label="$t('createPage.acceptanceCriteria', { count: manualCriteria.length })"
            header-class="text-grey-4 manual-expansion-header"
            class="manual-expansion q-mx-sm q-mb-sm"
          >
            <div class="q-pa-sm manual-section-body">
              <div class="row items-center q-gutter-sm q-mb-sm">
                <q-input
                  v-model="newManualCriterion"
                  dark
                  dense
                  borderless
                  :placeholder="$t('createPage.addCriterion')"
                  class="col manual-input"
                  input-class="manual-input-inner"
                  @keydown.enter.prevent="addManualCriterion"
                />
                <q-btn
                  flat
                  dense
                  round
                  icon="add"
                  color="indigo-4"
                  :disable="!newManualCriterion.trim()"
                  @click="addManualCriterion"
                >
                  <q-tooltip>{{ $t('tooltip.addCriterion') }}</q-tooltip>
                </q-btn>
              </div>
              <div
                v-for="(crit, idx) in manualCriteria"
                :key="`crit-${idx}`"
                class="row items-center q-py-xs manual-item"
              >
                <span class="col text-caption text-grey-4">{{ crit }}</span>
                <q-btn
                  flat
                  dense
                  round
                  icon="close"
                  size="xs"
                  color="grey-6"
                  @click="removeManualCriterion(idx)"
                >
                  <q-tooltip>{{ $t('tooltip.removeCriterion') }}</q-tooltip>
                </q-btn>
              </div>
            </div>
          </q-expansion-item>

          <q-separator color="grey-9" />
        </template>

        <!-- Bottom bar -->
        <div class="card-bottom-bar row items-center wrap q-px-sm q-py-xs q-gutter-xs">
          <!-- Model selector -->
          <q-select
            v-model="model"
            :options="modelOptions"
            dense
            borderless
            class="bottom-select rounded-borders model-select"
            hide-dropdown-icon
            emit-value
            map-options
            option-value="value"
            option-label="label"
          >
            <template #selected>
              <span class="bottom-select-label row items-center no-wrap">
                {{ modelOptions.find(m => m.value === model)?.label ?? model }}
                <q-icon name="expand_more" size="12px" color="grey-5" />
              </span>
            </template>
            <template #option="{ opt, itemProps }">
              <q-item v-bind="itemProps" class="model-option">
                <q-item-section>
                  <q-item-label class="text-white">{{ opt.label }}</q-item-label>
                  <q-item-label caption class="text-grey-5">{{ opt.description }}</q-item-label>
                </q-item-section>
              </q-item>
            </template>
          </q-select>

          <!-- Reasoning effort selector -->
          <q-select
            v-model="reasoningEffort"
            :options="reasoningOptions"
            dense
            borderless
            class="bottom-select rounded-borders"
            hide-dropdown-icon
            emit-value
            map-options
            option-value="value"
            option-label="label"
          >
            <template #selected>
              <span class="bottom-select-label row items-center no-wrap">
                <q-icon name="psychology" size="12px" color="grey-5" class="q-mr-xs" />
                {{ reasoningOptions.find(r => r.value === reasoningEffort)?.label ?? reasoningEffort }}
                <q-icon name="expand_more" size="12px" color="grey-5" />
              </span>
            </template>
            <template #option="{ opt, itemProps }">
              <q-item v-bind="itemProps">
                <q-item-section>
                  <q-item-label class="text-white">{{ opt.label }}</q-item-label>
                  <q-item-label caption class="text-grey-5">{{ opt.description }}</q-item-label>
                </q-item-section>
              </q-item>
            </template>
          </q-select>

          <!-- Permission mode selector -->
          <q-select
            v-model="permissionMode"
            :options="[
              { label: $t('permissionMode.plan'), value: 'plan' },
              { label: $t('permissionMode.autoAccept'), value: 'auto-accept' },
            ]"
            dense
            borderless
            class="bottom-select rounded-borders"
            hide-dropdown-icon
            emit-value
            map-options
          >
            <template #selected>
              <span class="bottom-select-label row items-center no-wrap">
                <q-icon :name="permissionMode === 'plan' ? 'visibility' : 'flash_on'" size="12px" color="amber-6" class="q-mr-xs" />
                {{ permissionMode === 'plan' ? $t('permissionMode.plan') : $t('permissionMode.autoAccept') }}
                <q-icon name="expand_more" size="12px" color="grey-5" />
              </span>
            </template>
          </q-select>

          <q-btn
            flat
            round
            dense
            size="sm"
            :icon="skipSetupScript ? 'play_disabled' : 'play_circle'"
            :color="skipSetupScript ? 'orange-4' : 'grey-6'"
            @click="skipSetupScript = !skipSetupScript"
          >
            <q-tooltip>{{ $t('createPage.skipSetupScript') }}</q-tooltip>
          </q-btn>

          <q-space />

          <!-- Repo path input with suggestions -->
          <q-select
            v-model="projectPath"
            :options="pathFilterOptions"
            dense
            borderless
            use-input
            hide-selected
            fill-input
            input-debounce="0"
            new-value-mode="add"
            class="bottom-select rounded-borders repo-select"
            hide-dropdown-icon
            :behavior="settingsStore.projectPaths.length > 0 ? 'menu' : 'dialog'"
            @filter="filterProjectPaths"
            @input-value="(val: string) => { projectPath = val }"
          >
            <template #prepend>
              <q-icon name="attach_file" size="12px" color="grey-5" />
            </template>
            <template #selected>
              <span class="bottom-select-label row items-center no-wrap">
                {{ projectPath || $t('createPage.projectPath') }}
              </span>
            </template>
            <template #no-option>
              <q-item>
                <q-item-section class="text-grey-6 text-caption">
                  {{ $t('createPage.enterPath') }}
                </q-item-section>
              </q-item>
            </template>
          </q-select>

          <!-- Branch type selector (feature / fix / hotfix / …) -->
          <q-select
            v-model="branchType"
            :options="branchTypeOptions"
            emit-value
            map-options
            dense
            borderless
            class="bottom-select rounded-borders branch-type-select"
            hide-dropdown-icon
          >
            <template #selected>
              <span class="bottom-select-label row items-center no-wrap">
                <q-icon name="account_tree" size="12px" color="grey-5" class="q-mr-xs" />
                {{ branchType }}/
                <q-icon name="expand_more" size="12px" color="grey-5" />
              </span>
            </template>
            <q-tooltip>{{ $t('createPage.branchType') }}</q-tooltip>
          </q-select>

          <!-- Branch selector (source branch) -->
          <q-select
            v-model="branch"
            :options="branches"
            dense
            borderless
            class="bottom-select rounded-borders branch-select"
            hide-dropdown-icon
            :loading="loadingBranches"
            :disable="!projectPath.trim() || loadingBranches"
          >
            <template #selected>
              <span class="bottom-select-label row items-center no-wrap">
                <q-icon name="call_split" size="12px" color="grey-5" class="q-mr-xs" />
                {{ branch ?? $t('createPage.branch') }}
                <q-icon name="expand_more" size="12px" color="grey-5" />
              </span>
            </template>
            <template #no-option>
              <q-item>
                <q-item-section class="text-grey-6 text-caption">
                  {{ projectPath.trim() ? $t('createPage.noBranches') : $t('createPage.enterPath') }}
                </q-item-section>
              </q-item>
            </template>
          </q-select>

          <!-- Create button -->
          <q-btn
            :label="$t('createPage.create')"
            no-caps
            unelevated
            class="create-btn text-weight-bold rounded-borders"
            :loading="submitting"
            @click="handleCreate"
          />
        </div>
      </div>

      <!-- Hint text -->
      <div class="create-hint text-center text-body2 q-mt-md text-grey-8">
        {{ useNotion
          ? $t('createPage.notionExtractHint')
          : $t('createPage.notionImportHint')
        }}
      </div>
    </div>
  </q-page>
</template>

<style lang="scss" scoped>
.create-page {
  background-color: #1a1a2e;
  min-height: 100%;
  padding: 48px 24px;
}

.create-inner {
  width: 100%;
  max-width: 700px;
}

.create-title {
  font-size: 24px;
  line-height: 1.3;
}

.create-card {
  background: #222244;
  border: 1px solid #444;
  overflow: hidden;
}

.card-top-bar {
  min-height: 36px;
  background: #1e1e3a;
}

.card-name-wrap {
  padding: 8px 16px 4px;
  background: #222244;

  :deep(.q-field__control) {
    padding: 0;
    height: 32px;
    min-height: 32px;
  }

  :deep(input) {
    font-size: 15px;
    font-weight: 500;
    color: #e0e0e0;

    &::placeholder {
      color: #555;
    }
  }
}

.card-textarea-wrap {
  background: #222244;
}

.repo-select {
  min-width: 160px;
  max-width: 260px;

  :deep(.q-field__prepend) {
    padding-top: 0;
    height: auto;
    align-items: center;
  }
}

.create-textarea {
  width: 100%;
  padding: 12px 16px 4px;
  color: #d0d0d0;

  :deep(.q-field__control) {
    padding: 0;
  }

  :deep(textarea) {
    color: #d0d0d0;
    font-size: 14px;
    line-height: 1.6;
    resize: none;
    min-height: 100px;

    &::placeholder {
      color: #666;
    }
  }
}

.notion-toggle-btn {
  padding: 2px 10px;
  background: #333;
}

.notion-url-wrap {
  background: #1e1e3a;
  padding: 8px 0 0;
}

.notion-url-input {
  padding: 0 12px;

  :deep(.q-field__control) {
    padding: 0;
    height: 36px;
    min-height: 36px;
  }

  :deep(input) {
    font-size: 13px;
    color: #d0d0d0;

    &::placeholder {
      color: #555;
      font-size: 12px;
    }
  }
}

.notion-error {
  padding-bottom: 6px;
}

.notion-valid {
  padding-bottom: 6px;
}

.sentry-toggle-btn {
  padding: 2px 10px;
  background: #333;
}

.sentry-url-wrap {
  background: #1e1e3a;
  padding: 8px 0 0;
}

.sentry-url-input {
  padding: 0 12px;

  :deep(.q-field__control) {
    padding: 0;
    height: 36px;
    min-height: 36px;
  }

  :deep(input) {
    font-size: 13px;
    color: #d0d0d0;

    &::placeholder {
      color: #555;
      font-size: 12px;
    }
  }
}

.sentry-error {
  padding-bottom: 6px;
}

.sentry-valid {
  padding-bottom: 6px;
}

// Slide transition for Notion URL
.slide-enter-active,
.slide-leave-active {
  transition: all 0.2s ease;
  overflow: hidden;
}
.slide-enter-from,
.slide-leave-to {
  max-height: 0;
  opacity: 0;
}
.slide-enter-to,
.slide-leave-from {
  max-height: 120px;
  opacity: 1;
}

.card-bottom-bar {
  background: #1e1e3a;
  min-height: 40px;
}

.bottom-select {
  background: #333;
  padding: 0 6px;
  min-width: 60px;
  height: 28px;

  :deep(.q-field__control) {
    height: 28px;
    min-height: 28px;
    padding: 0;
  }

  :deep(.q-field__native) {
    padding: 0;
    min-height: unset;
  }
}

.bottom-select-label {
  font-size: 11px;
  color: #bbb;
  gap: 2px;
}

.bottom-sep {
  color: #555;
  font-size: 12px;
  line-height: 1;
  padding: 0 2px;
}

.repo-path-wrap {
  background: #333;
  border-radius: 6px;
  padding: 0 8px;
  height: 28px;
}

.repo-input {
  min-width: 140px;

  :deep(.q-field__control) {
    height: 28px;
    min-height: 28px;
    padding: 0;
  }

  :deep(input) {
    font-size: 11px;
    color: #bbb;

    &::placeholder {
      color: #666;
      font-size: 11px;
    }
  }
}

.branch-select {
  min-width: 80px;
}

.create-btn {
  background: #4f46e5;
  color: #fff;
  font-size: 12px;
  height: 28px;
  padding: 0 14px;

  :deep(.q-btn__content) {
    height: 28px;
  }
}

.create-hint {
  line-height: 1.5;
}

// Fade transition for Notion badge
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

// Manual tasks / criteria sections
.manual-hint {
  background: #1e1e3a;
  line-height: 1.4;
}

.manual-expansion {
  background: #1e1e3a;
  border: 1px solid #333;
  border-radius: 4px;
  margin-top: 6px;
  overflow: hidden;

  :deep(.manual-expansion-header) {
    min-height: 32px;
    padding: 4px 10px;
    font-size: 12px;
  }

  :deep(.q-expansion-item__content) {
    background: #1a1a2e;
  }
}

.manual-section-body {
  background: #1a1a2e;
}

.manual-input {
  :deep(.q-field__control) {
    padding: 0;
    height: 26px;
    min-height: 26px;
  }

  :deep(input) {
    font-size: 12px;
    color: #e0e0e0;

    &::placeholder {
      color: #555;
    }
  }
}

.manual-item {
  border-top: 1px solid rgba(255, 255, 255, 0.04);

  &:first-child {
    border-top: none;
  }
}
</style>
