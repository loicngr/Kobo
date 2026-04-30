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
            <span class="text-indigo-3 text-weight-medium text-caption">
              {{ selectedEngine?.displayName ?? $t('createPage.claudeCode') }}
            </span>
          </span>
          <q-space />
          <q-btn
            flat
            dense
            no-caps
            size="sm"
            :color="useNotion ? 'green-4' : 'grey-5'"
            class="notion-toggle-btn text-caption rounded-borders"
            :disable="useExistingWorktree"
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
            :disable="useExistingWorktree"
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
            <div v-if="isValidNotionUrl && notionUrlHasPanelPeek" class="notion-peek-choice q-px-md q-pb-sm">
              <div class="text-caption text-grey-4 q-mb-sm">
                <q-icon name="info" size="14px" color="indigo-4" class="q-mr-xs" />
                {{ $t('createPage.notionPanelChoiceLabel') }}
              </div>
              <div class="row q-gutter-sm">
                <button
                  type="button"
                  class="peek-card col"
                  :class="{ 'peek-card--active': notionPageChoice === 'panel' }"
                  @click="notionPageChoice = 'panel'"
                >
                  <q-icon name="article" size="22px" class="peek-card-icon" />
                  <div class="peek-card-text">
                    <div class="peek-card-title">{{ $t('createPage.notionPanelOption') }}</div>
                    <div class="peek-card-desc">{{ $t('createPage.notionPanelOptionDesc') }}</div>
                  </div>
                  <q-icon
                    v-if="notionPageChoice === 'panel'"
                    name="check_circle"
                    size="18px"
                    color="indigo-4"
                    class="peek-card-check"
                  />
                </button>
                <button
                  type="button"
                  class="peek-card col"
                  :class="{ 'peek-card--active': notionPageChoice === 'parent' }"
                  @click="notionPageChoice = 'parent'"
                >
                  <q-icon name="folder_open" size="22px" class="peek-card-icon" />
                  <div class="peek-card-text">
                    <div class="peek-card-title">{{ $t('createPage.notionParentOption') }}</div>
                    <div class="peek-card-desc">{{ $t('createPage.notionParentOptionDesc') }}</div>
                  </div>
                  <q-icon
                    v-if="notionPageChoice === 'parent'"
                    name="check_circle"
                    size="18px"
                    color="indigo-4"
                    class="peek-card-check"
                  />
                </button>
              </div>
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

        <!-- Textarea (description / additional instructions). Wrapped in a
             relative container so the slash-autocomplete popup can be
             positioned above the input via `position: absolute`. -->
        <div class="card-textarea-wrap">
          <q-input
            ref="descriptionRef"
            v-model="description"
            type="textarea"
            borderless
            autogrow
            :rows="3"
            :placeholder="useNotion ? $t('createPage.instructions') : $t('createPage.instructionsPlaceholder')"
            class="create-textarea"
            input-class="create-textarea-input"
            @keydown="onDescriptionKeydown"
            @keydown.ctrl.enter="handleCreate"
            @keydown.meta.enter="handleCreate"
          />
          <SlashSuggestionsPopup
            v-if="showSlashPopup && slashFlat.length > 0"
            class="create-slash-popup"
            :grouped-dropdown="slashGrouped"
            :flat-dropdown="slashFlat"
            :selected-index="slashIndex"
            @select="onSlashSelect"
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

        <!-- Bottom bar: agent config (row 1) + git config (row 2) -->
        <div class="card-bottom-bar">

        <!-- Row 1: agent configuration (engine, model, reasoning, permission) -->
        <div class="row q-col-gutter-xs q-px-xs">
          <div
              v-if="engineSelectOptions.length > 0"
              class="col-12 col-sm-6 col-md-3"
          >
            <!-- Engine selector — dynamically populated from /api/engines -->
            <q-select
                v-model="selectedEngineId"
                :options="engineSelectOptions"
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
                <q-icon name="hub" size="12px" color="grey-5" class="q-mr-xs" />
                {{ engineSelectOptions.find((e) => e.value === selectedEngineId)?.label ?? selectedEngineId }}
                <q-icon name="expand_more" size="12px" color="grey-5" />
              </span>
              </template>
              <q-tooltip>{{ $t('engine.select') }}</q-tooltip>
            </q-select>
          </div>

          <div class="col-12 col-sm-6 col-md-3">
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
          </div>

          <div class="col-12 col-sm-6 col-md-3">
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
          </div>

          <div class="col-12 col-sm-6 col-md-3">
            <!-- Permission mode selector — options come from the selected
               engine's capabilities; labels resolve to i18n keys.
               Disabled when auto-loop is on: auto-loop needs MCP + edits, which
               plan mode blocks, so the permission is locked to auto-accept. -->
            <q-select
                v-model="permissionMode"
                :options="enginePermissionOptions"
                :disable="autoLoop"
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
                <q-icon :name="autoLoop ? 'flash_on' : permissionMode === 'plan' ? 'visibility' : 'flash_on'" size="12px" color="amber-6" class="q-mr-xs" />
                {{ autoLoop ? (enginePermissionOptions.find((p) => p.value === 'auto-accept')?.label ?? 'auto-accept') : (enginePermissionOptions.find((p) => p.value === permissionMode)?.label ?? permissionMode) }}
                <q-icon v-if="!autoLoop" name="expand_more" size="12px" color="grey-5" />
              </span>
              </template>
              <q-tooltip>{{ autoLoop ? $t('createPage.permissionLockedByAutoLoop') : $t('engine.permission') }}</q-tooltip>
            </q-select>
          </div>
        </div>

        <!-- Row 1b: action toggles (auto-loop, skip-setup, attach-worktree) -->
        <div class="row q-col-gutter-xs q-pa-xs col-12  items-center justify-center">
          <div class="col-12 col-md-auto">
            <!-- Auto-loop toggle -->
            <q-btn
                flat
                dense
                size="sm"
                no-caps
                :icon="autoLoop ? 'autorenew' : 'sync_disabled'"
                :color="autoLoop ? 'amber-4' : 'grey-5'"
                :label="$t('autoLoop.startInMode')"
                class="skip-setup-btn"
                @click="autoLoop = !autoLoop"
            >
              <q-tooltip>{{ $t('autoLoop.startInMode') }}</q-tooltip>
            </q-btn>
          </div>

          <div class="col-12 col-md-auto">
            <!-- Skip-setup toggle -->
            <q-btn
                flat
                dense
                size="sm"
                no-caps
                :icon="skipSetupScript ? 'play_disabled' : 'play_circle'"
                :color="skipSetupScript ? 'orange-4' : 'grey-5'"
                :label="$t('createPage.skipSetupScript')"
                class="skip-setup-btn"
                @click="skipSetupScript = !skipSetupScript"
            >
              <q-tooltip>{{ $t('createPage.skipSetupScript') }}</q-tooltip>
            </q-btn>
          </div>

          <div class="col-12 col-md-auto">
            <!-- Attach existing worktree toggle -->
            <q-btn
                flat
                dense
                size="sm"
                no-caps
                icon="folder_open"
                :color="useExistingWorktree ? 'cyan-4' : 'grey-5'"
                :label="useExistingWorktree ? $t('createPage.attachWorktreeEnabled') : $t('createPage.attachWorktreeToggle')"
                class="skip-setup-btn"
                @click="toggleExistingWorktree"
            />
          </div>
        </div>

        <!-- Row 2: git configuration (repo path, branch type, source branch) -->
        <div class="row q-col-gutter-xs q-px-xs bottom-row-git">
          <div class="col-12 col-md-4">
            <!-- Repo path input with suggestions -->
            <q-select
                v-model="projectPath"
                :options="pathFilterOptions"
                dense
                borderless
                use-input
                fill-input
                hide-selected
                input-debounce="0"
                new-value-mode="add"
                class="bottom-select rounded-borders repo-select"
                hide-dropdown-icon
                :input-class="!projectPath ? 'repo-input-empty' : ''"
                :placeholder="$t('createPage.projectPath')"
                :behavior="settingsStore.projectPaths.length > 0 ? 'menu' : 'dialog'"
                @filter="filterProjectPaths"
                @input-value="(val: string) => { projectPath = val }"
            >
              <template #prepend>
                <q-icon name="folder" size="14px" color="grey-5" />
              </template>
              <template #no-option>
                <q-item>
                  <q-item-section class="text-grey-6 text-caption">
                    {{ $t('createPage.enterPath') }}
                  </q-item-section>
                </q-item>
              </template>
            </q-select>
          </div>

          <div
              v-if="!useExistingWorktree"
              class="col-12 col-md-4"
          >
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
          </div>

          <div
              v-if="useExistingWorktree"
              class="col-12 col-md-4"
          >
            <!-- Existing-worktree picker (only when reuse toggle is on).
               Sits before the source-branch picker; selecting a worktree
               auto-fills `branch` with its `suggestedSourceBranch`, but the
               user can still override that via the branch picker below. -->
            <q-select
                v-model="selectedWorktreePath"
                :options="orphanWorktrees"
                option-label="branch"
                option-value="path"
                emit-value
                map-options
                use-input
                dense
                borderless
                class="bottom-select rounded-borders worktree-select"
                hide-dropdown-icon
                :loading="loadingOrphanWorktrees"
                :disable="!projectPath.trim() || loadingOrphanWorktrees"
            >
              <template #selected>
              <span class="bottom-select-label row items-center no-wrap">
                <q-icon name="folder_open" size="12px" color="cyan-5" class="q-mr-xs" />
                {{
                  selectedWorktreePath
                      ? orphanWorktrees.find((w) => w.path === selectedWorktreePath)?.branch ?? selectedWorktreePath
                      : $t('createPage.worktreePickerLabel')
                }}
                <q-icon name="expand_more" size="12px" color="grey-5" />
              </span>
              </template>
              <template #option="scope">
                <q-item v-bind="scope.itemProps">
                  <q-item-section>
                    <q-item-label>{{ scope.opt.branch }}</q-item-label>
                    <q-item-label caption>{{ scope.opt.path }}</q-item-label>
                  </q-item-section>
                </q-item>
              </template>
              <template #no-option>
                <q-item>
                  <q-item-section class="text-grey-6 text-caption">
                    {{ projectPath.trim() ? $t('createPage.noOrphanWorktrees') : $t('createPage.enterPath') }}
                  </q-item-section>
                </q-item>
              </template>
            </q-select>
          </div>

          <div class="col-12 col-md-4">
            <!-- Branch selector (source branch) -->
            <q-select
                v-model="branch"
                :options="branchFilterOptions"
                dense
                borderless
                class="bottom-select rounded-borders branch-select"
                hide-dropdown-icon
                use-input
                input-debounce="0"
                :loading="loadingBranches"
                :disable="!projectPath.trim() || loadingBranches"
                @filter="filterBranches"
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
          </div>
        </div>
      </div>

        <!-- Create button (centered, full-width row below the bottom bar) -->
        <div class="row justify-center q-px-sm q-py-sm">
          <q-btn
            :label="$t('createPage.create')"
            no-caps
            unelevated
            class="create-btn text-weight-bold rounded-borders"
            :loading="submitting"
            :disable="submitting || (useExistingWorktree && !selectedWorktreePath)"
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

<script setup lang="ts">
import type { QInput } from 'quasar'
import { useQuasar } from 'quasar'
import SlashSuggestionsPopup from 'src/components/SlashSuggestionsPopup.vue'
import { type SlashDropdownItem, useSlashAutocomplete } from 'src/composables/use-slash-autocomplete'
import { MODEL_OPTION_DEFS } from 'src/constants/models'
import { useSettingsStore } from 'src/stores/settings'
import { useTemplatesStore } from 'src/stores/templates'
import { useWebSocketStore } from 'src/stores/websocket'
import { useWorkspaceStore } from 'src/stores/workspace'
import { buildTemplateVars, expandTemplate } from 'src/utils/expand-template'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

interface EngineDto {
  id: string
  displayName: string
  capabilities: {
    models: Array<{ id: string; label: string }>
    effortLevels?: Array<{ id: string; label: string }>
    permissionModes: Array<'auto-accept' | 'plan'>
    supportsResume: boolean
    supportsMcp: boolean
    supportsSkills: boolean
  }
}

const router = useRouter()
const $q = useQuasar()
const store = useWorkspaceStore()
const settingsStore = useSettingsStore()
const { t } = useI18n()

const pathFilterOptions = ref<string[]>([])

// Form fields
const workspaceName = ref('')
const description = ref('')
const descriptionRef = ref<QInput | null>(null)
const notionUrl = ref('')
const useNotion = ref(false)
const model = ref('claude-opus-4-7')
const reasoningEffort = ref('auto')
const projectPath = ref('')
const branch = ref<string | null>(null)
const branchType = ref('feature')
const skipSetupScript = ref(false)

// Engine selector state — engine list is loaded from `/api/engines` on mount.
const engines = ref<EngineDto[]>([])
const selectedEngineId = ref<string>('claude-code')
const selectedEngine = computed<EngineDto | undefined>(() => engines.value.find((e) => e.id === selectedEngineId.value))
const engineSelectOptions = computed(() => engines.value.map((e) => ({ value: e.id, label: e.displayName })))
// Permission options: only the ones the selected engine declares it
// supports, labelled via i18n keys.
const enginePermissionOptions = computed(() =>
  (selectedEngine.value?.capabilities.permissionModes ?? ['auto-accept', 'plan']).map((p) => ({
    value: p,
    label: t(`engine.permission.${p}`),
  })),
)

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
const branchFilterOptions = ref<string[]>([])
const loadingBranches = ref(false)
const submitting = ref(false)

function filterBranches(val: string, update: (fn: () => void) => void) {
  update(() => {
    branchFilterOptions.value = val
      ? branches.value.filter((b) => b.toLowerCase().includes(val.toLowerCase()))
      : branches.value
  })
}

// Slash autocomplete on the description textarea — same UX as ChatInput.
// Kōbō built-in commands are excluded because there's no workspace yet
// (e.g. `/kobo-prep-autoloop` makes no sense before the workspace exists).
const templatesStore = useTemplatesStore()
function getDescriptionEl(): HTMLTextAreaElement | null {
  return (descriptionRef.value?.nativeEl as HTMLTextAreaElement | undefined) ?? null
}
const {
  showSkills: showSlashPopup,
  selectedSkillIndex: slashIndex,
  groupedDropdown: slashGrouped,
  flatDropdown: slashFlat,
  fetchSkills: fetchSlashSkills,
  detectSlashFragment: detectSlash,
  replaceFragmentWith: replaceSlash,
  closeDropdown: closeSlash,
} = useSlashAutocomplete(description, getDescriptionEl, { excludeKoboCommands: true })

void fetchSlashSkills()

// Re-evaluate the dropdown after every textarea change.
watch(description, async () => {
  await nextTick()
  await detectSlash()
})

function onSlashSelect(item: SlashDropdownItem) {
  if (item.type === 'template') {
    const tpl = templatesStore.templates.find((t) => t.slug === item.name)
    if (!tpl) return
    // No workspace context yet — variables resolve to placeholders / empty.
    const expanded = expandTemplate(
      tpl.content,
      buildTemplateVars({ workspace: null, gitStats: null, sessionName: null }),
    )
    replaceSlash(expanded)
    closeSlash()
    return
  }
  // Skills (Claude or Kōbō): just complete the fragment with `/<name> `.
  replaceSlash(`/${item.name} `)
  closeSlash()
}

function onDescriptionKeydown(event: KeyboardEvent) {
  if (!showSlashPopup.value || slashFlat.value.length === 0) return
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    slashIndex.value = (slashIndex.value + 1) % slashFlat.value.length
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    slashIndex.value = (slashIndex.value - 1 + slashFlat.value.length) % slashFlat.value.length
  } else if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
    event.preventDefault()
    onSlashSelect(slashFlat.value[slashIndex.value])
  } else if (event.key === 'Escape') {
    event.preventDefault()
    closeSlash()
  }
}

// Model options — `MODEL_OPTION_DEFS` is the single source of truth for
// the display list (i18n labels + descriptions). The backend capabilities
// are used only for server-side validation in `POST /api/workspaces`, not
// for UI rendering, so we don't override the local list when /api/engines
// responds. Any future model additions go in `src/constants/models.ts`.
const modelOptions = computed(() =>
  MODEL_OPTION_DEFS.map((option) => ({
    label: t(option.i18nLabelKey),
    value: option.value,
    description: t(option.i18nDescriptionKey),
  })),
)

function formatReasoningLabel(label: string): string {
  const separatorIndex = label.indexOf(':')
  if (separatorIndex >= 0) return label.slice(separatorIndex + 1).trim()
  return label
}

// Reasoning effort options — local i18n-driven list. Same story as
// `modelOptions`: UI rendering comes from the frontend translations, not
// from /api/engines. The backend's `effortLevels` field is used only for
// server-side validation on the POST route.
const reasoningOptions = computed(() => [
  { label: formatReasoningLabel(t('reasoning.auto')), value: 'auto', description: t('reasoning.autoDescription') },
  { label: formatReasoningLabel(t('reasoning.low')), value: 'low', description: t('reasoning.lowDescription') },
  {
    label: formatReasoningLabel(t('reasoning.medium')),
    value: 'medium',
    description: t('reasoning.mediumDescription'),
  },
  { label: formatReasoningLabel(t('reasoning.high')), value: 'high', description: t('reasoning.highDescription') },
  {
    label: formatReasoningLabel(t('reasoning.xhigh')),
    value: 'xhigh',
    description: t('reasoning.xhighDescription'),
  },
  { label: formatReasoningLabel(t('reasoning.max')), value: 'max', description: t('reasoning.maxDescription') },
])

// Validate Notion URL
const isValidNotionUrl = computed(() => notionUrl.value.trim().startsWith('https://www.notion.so/'))

// Notion side-peek: when the URL embeds `?p=<32hex>`, the path component is a
// parent page / database and the actual page being viewed sits in the query.
// Ask the user explicitly which one they want to bootstrap the workspace from.
const notionUrlHasPanelPeek = computed(() => /[?&]p=[0-9a-f]{32}(?:[&#]|$)/i.test(notionUrl.value))
const notionPageChoice = ref<'panel' | 'parent'>('panel')

function getEffectiveNotionUrl(): string {
  const raw = notionUrl.value.trim()
  if (notionPageChoice.value === 'parent' && notionUrlHasPanelPeek.value) {
    return raw
      .replace(/([?&])p=[0-9a-f]{32}(?=[&#]|$)/i, '$1')
      .replace(/([?&])pm=[a-z]+(?=[&#]|$)/i, '$1')
      .replace(/[?&]+$/, '')
      .replace(/\?&/, '?')
  }
  return raw
}

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
const autoLoop = ref(false)
const sentryUrl = ref('')
const isValidSentryUrl = computed(() => /\/issues\/\d+/.test(sentryUrl.value.trim()))

function toggleSentry() {
  useSentry.value = !useSentry.value
  if (!useSentry.value) sentryUrl.value = ''
}

// Existing-worktree reuse: instead of creating a new worktree under
// `<projectPath>/.worktrees/<workingBranch>`, the user can attach an existing
// orphan worktree (no Kōbō workspace currently owns it). Backend forces
// `worktreeOwned=false` + `skipSetupScript=true` when this is on.
const useExistingWorktree = ref(false)
const selectedWorktreePath = ref<string | null>(null)
const orphanWorktrees = ref<Array<{ path: string; branch: string; head: string; suggestedSourceBranch: string }>>([])
const loadingOrphanWorktrees = ref(false)

async function fetchOrphans() {
  if (!projectPath.value.trim()) {
    orphanWorktrees.value = []
    return
  }
  loadingOrphanWorktrees.value = true
  try {
    orphanWorktrees.value = await store.fetchOrphanWorktrees(projectPath.value.trim())
  } catch {
    orphanWorktrees.value = []
  } finally {
    loadingOrphanWorktrees.value = false
  }
}

function toggleExistingWorktree() {
  useExistingWorktree.value = !useExistingWorktree.value
  if (useExistingWorktree.value) {
    // Reuse mode is mutually exclusive with Notion / Sentry imports — wipe
    // any in-flight state so the user can't submit a stale URL alongside.
    useNotion.value = false
    notionUrl.value = ''
    useSentry.value = false
    sentryUrl.value = ''
    // Reused worktree is presumed already set up — re-running the setup
    // script could destroy state. User can still un-check manually.
    skipSetupScript.value = true
    void fetchOrphans()
  } else {
    selectedWorktreePath.value = null
  }
}

watch(projectPath, () => {
  selectedWorktreePath.value = null
  if (useExistingWorktree.value) {
    void fetchOrphans()
  }
})

watch(selectedWorktreePath, (newPath) => {
  if (!newPath) return
  const wt = orphanWorktrees.value.find((w) => w.path === newPath)
  if (wt) branch.value = wt.suggestedSourceBranch
  // A reused worktree is presumed already set up — re-running the setup
  // script could destroy state (db reset, node_modules wipe, etc.).
  skipSetupScript.value = true
})

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

// Fetch settings + available engines on mount. The engine list powers the
// engine selector and drives the model / effort / permission options.
onMounted(async () => {
  settingsStore.fetchSettings()
  try {
    const res = await fetch('/api/engines')
    if (res.ok) {
      engines.value = (await res.json()) as EngineDto[]
    }
  } catch {
    // Best-effort: the legacy hardcoded fallback keeps the form usable.
  }
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
  if (!useNotion.value && !useSentry.value && description.value.trim()) {
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

  if (useExistingWorktree.value && !selectedWorktreePath.value) {
    $q.notify({ type: 'negative', message: t('createPage.pickWorktreeRequired'), position: 'top' })
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
      branchSlug = branchNameFromNotionUrl(getEffectiveNotionUrl())
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
      // Reuse-an-existing-worktree branch: skip generating a workingBranch
      // (backend ignores it when worktreePath is set) and force skipSetupScript.
      // Standard branch: keep the generated workingBranch as before.
      ...(useExistingWorktree.value && selectedWorktreePath.value
        ? { worktreePath: selectedWorktreePath.value, skipSetupScript: true }
        : { workingBranch }),
      engine: selectedEngineId.value,
      model: model.value,
      reasoningEffort: reasoningEffort.value,
      ...(useNotion.value && isValidNotionUrl.value ? { notionUrl: getEffectiveNotionUrl() } : {}),
      ...(useSentry.value && isValidSentryUrl.value ? { sentryUrl: sentryUrl.value.trim() } : {}),
      ...(showManualSections.value && manualTasks.value.length > 0 ? { tasks: manualTasks.value } : {}),
      ...(showManualSections.value && manualCriteria.value.length > 0
        ? { acceptanceCriteria: manualCriteria.value }
        : {}),
      ...(skipSetupScript.value && !useExistingWorktree.value ? { skipSetupScript: true } : {}),
      ...(description.value.trim() ? { description: description.value.trim() } : {}),
      ...(autoLoop.value ? { autoLoop: true } : {}),
      // Auto-loop needs MCP tools (kobo__list_tasks, kobo__create_task, etc.) for
      // grooming. Plan mode blocks all MCP tools, so force auto-accept when
      // autoLoop is on — otherwise the first session errors on "permission not granted".
      permissionMode: autoLoop.value ? 'auto-accept' : permissionMode.value,
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
  position: relative; // anchor for the slash-autocomplete popup
}

// Slash-autocomplete popup positioning. CreatePage has plenty of empty
// space below the textarea, so we float the dropdown DOWNWARDS (unlike
// ChatInput where it must go up because the textarea sits at the bottom
// of the viewport). Anchored 4 px under the textarea, flush with its
// horizontal padding.
.create-slash-popup {
  position: absolute;
  top: calc(100% + 4px);
  left: 12px;
  right: 12px;
  z-index: 9999;
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

.notion-peek-choice {
  padding-top: 4px;
}

.peek-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  color: #e0e0e0;
  font-family: inherit;
  font-size: inherit;
  transition: background 0.15s, border-color 0.15s, transform 0.1s;

  &:hover {
    background: rgba(255, 255, 255, 0.06);
    border-color: rgba(108, 99, 255, 0.4);
  }

  &:active {
    transform: scale(0.99);
  }

  &--active {
    background: rgba(108, 99, 255, 0.12);
    border-color: rgba(108, 99, 255, 0.85);
    box-shadow: 0 0 0 1px rgba(108, 99, 255, 0.4);

    .peek-card-icon {
      color: #8a82ff;
    }

    .peek-card-title {
      color: #ffffff;
    }
  }
}

.peek-card-icon {
  flex-shrink: 0;
  color: #999;
}

.peek-card-text {
  flex: 1;
  min-width: 0;
  line-height: 1.25;
}

.peek-card-title {
  font-size: 12px;
  font-weight: 600;
  color: #d0d0d0;
}

.peek-card-desc {
  font-size: 10.5px;
  color: #888;
  margin-top: 2px;
}

.peek-card-check {
  flex-shrink: 0;
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
}

.skip-setup-btn {
  font-size: 11px;
  padding: 2px 10px;
  min-height: 28px;
}
.skip-setup-btn :deep(.q-btn__content) {
  gap: 4px;
}
.skip-setup-btn :deep(.q-icon) {
  font-size: 14px;
}

// Width split is handled by Quasar's grid (col-12 / col-md-4 on each
// selector). Just truncate long labels instead of wrapping them.
.bottom-row-git {
  .bottom-select-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.bottom-row-git .bottom-select.repo-select :deep(input) {
  font-size: 11px;
  color: #bbb;
  padding: 0 4px;
}
.bottom-row-git .bottom-select.repo-select :deep(input::placeholder) {
  color: #666;
  font-style: italic;
}

.bottom-select {
  background: #333;
  padding: 0 6px;
  //min-width: 60px;
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
  font-size: 13px;
  height: 32px;
  min-width: 220px;
  padding: 0 32px;

  :deep(.q-btn__content) {
    height: 32px;
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
