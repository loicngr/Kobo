<template>
  <q-page class="create-page">
    <DrawerToggleButton class="create-page__drawer-toggle" />
    <div class="create-inner q-mx-auto">
      <header class="q-mb-lg">
        <div class="create-title text-weight-bold text-kobo-1">{{ $t('createPage.title') }}</div>
        <div class="text-body1 text-kobo-2 q-mt-xs">{{ $t('createPage.subtitle') }}</div>
      </header>

      <!--
        Both silent overrides (forced skip-setup-script, plan->bypass under
        auto-loop) are surfaced here, at the top of the form, rather than only
        as a note buried inside a collapsed "Advanced options" / "Configure
        agent" panel. A change of security posture (permission mode) in
        particular deserves to be seen without the user having to go looking
        for it. `resolvedOverrides` is the single source of truth also used to
        build the request payload, so this can never drift from what actually
        gets sent.
      -->
      <div v-if="resolvedOverrides.applied.length > 0" class="create-page__overrides q-mb-lg">
        <div class="create-page__overrides-title text-caption">
          <q-icon name="info" size="16px" />
          {{ $t('createPage.override.title') }}
        </div>
        <div v-for="id in resolvedOverrides.applied" :key="id" class="create-page__overrides-item text-caption">
          {{ $t(`createPage.override.${id}`) }}
        </div>
      </div>

      <div class="create-sections column">
        <q-card flat bordered class="create-section-card">
          <q-card-section class="row items-start no-wrap q-gutter-md">
            <q-avatar color="primary" text-color="white" icon="assignment" size="42px" />
            <div>
              <div class="text-subtitle1 text-weight-medium text-kobo-1">{{ $t('createPage.sectionMission') }}</div>
              <div class="text-body2 text-kobo-3">{{ $t('createPage.sectionMissionHint') }}</div>
            </div>
          </q-card-section>

          <q-separator dark />

          <q-card-section class="column q-gutter-y-md">
            <q-input
              ref="nameFieldRef"
              v-model="workspaceName"
              dark
              dense
              outlined
              stack-label
              :error="fieldError === 'name'"
              :error-message="fieldErrorMessage"
              :label="$t('createPage.workspaceNameLabel')"
              :placeholder="useNotion && isValidNotionUrl ? $t('createPage.workspaceName') : $t('createPage.workspaceNamePlaceholder')"
            />

            <div class="card-textarea-wrap">
              <q-input
                ref="descriptionRef"
                v-model="description"
                dark
                dense
                outlined
                stack-label
                type="textarea"
                autogrow
                :rows="6"
                :error="fieldError === 'description'"
                :error-message="fieldErrorMessage"
                :label="$t('createPage.descriptionLabel')"
                :placeholder="useNotion ? $t('createPage.instructions') : $t('createPage.instructionsPlaceholder')"
                class="create-textarea"
                @keydown="onDescriptionKeydown"
                @keydown.ctrl.enter="handleCreate"
                @keydown.meta.enter="handleCreate"
              >
                <template #append>
                  <div class="column items-center self-end q-pb-xs">
                    <q-spinner-dots v-if="isCreateVoiceTranscribing" size="18px" color="amber-6" />
                    <q-btn
                      flat
                      dense
                      round
                      size="sm"
                      :icon="isCreateVoiceTranscribing ? 'hourglass_top' : isCreateVoiceRecording ? 'mic' : 'mic_none'"
                      :color="isCreateVoiceRecording ? 'red-5' : isCreateVoiceTranscribing ? 'amber-6' : 'kobo-3'"
                      :disable="!createVoiceEnabled || isCreateVoiceTranscribing"
                      :class="{ 'voice-btn--recording': isCreateVoiceRecording }"
                      @mousedown.prevent="startCreateVoiceCapture"
                      @mouseup.prevent="stopCreateVoiceCapture"
                      @mouseleave.prevent="stopCreateVoiceCapture"
                      @touchstart.prevent="startCreateVoiceCapture"
                      @touchend.prevent="stopCreateVoiceCapture"
                    >
                      <q-tooltip>
                        {{
                          isCreateVoiceTranscribing
                            ? $t('voice.transcribing')
                            : isCreateVoiceRecording
                              ? $t('voice.recording')
                              : $t('voice.holdToTalk')
                        }}
                      </q-tooltip>
                    </q-btn>
                  </div>
                </template>
              </q-input>
              <SlashSuggestionsPopup
                v-if="showSlashPopup && slashFlat.length > 0"
                class="create-slash-popup"
                :grouped-dropdown="slashGrouped"
                :flat-dropdown="slashFlat"
                :selected-index="slashIndex"
                @select="onSlashSelect"
              />
            </div>

            <div
              v-if="settingsStore.global.notionEnabled || settingsStore.global.sentryEnabled"
              class="column q-gutter-y-sm"
            >
              <div class="text-caption text-weight-medium text-kobo-2">{{ $t('createPage.sources') }}</div>
              <div class="row q-gutter-sm">
                <q-btn
                  v-if="settingsStore.global.notionEnabled"
                  dense
                  outline
                  no-caps
                  icon="description"
                  :color="useNotion ? 'green-4' : 'kobo-2'"
                  :label="useNotion ? $t('createPage.notionEnabled') : $t('createPage.importNotion')"
                  :disable="useExistingWorktree"
                  @click="toggleNotion"
                />
                <q-btn
                  v-if="settingsStore.global.sentryEnabled"
                  dense
                  outline
                  no-caps
                  icon="bug_report"
                  :color="useSentry ? 'red-4' : 'kobo-2'"
                  :label="useSentry ? $t('createPage.sentryEnabled') : $t('createPage.importSentry')"
                  :disable="useExistingWorktree"
                  @click="toggleSentry"
                />
              </div>
            </div>

            <transition name="slide">
              <div v-if="useNotion" class="source-panel column q-gutter-y-sm q-pa-md rounded-borders">
                <q-input
                  ref="notionFieldRef"
                  v-model="notionUrl"
                  dark
                  outlined
                  dense
                  stack-label
                  :label="$t('createPage.importNotion')"
                  :placeholder="$t('createPage.notionPlaceholder')"
                  :error="Boolean(notionUrl.trim()) && !isValidNotionUrl"
                  :error-message="$t('createPage.notionValidation')"
                  :hint="isValidNotionUrl ? $t('createPage.notionAutoExtract') : undefined"
                >
                  <template #prepend>
                    <q-icon name="link" :color="isValidNotionUrl ? 'green-4' : 'kobo-3'" />
                  </template>
                </q-input>
                <div v-if="isValidNotionUrl && notionUrlHasPanelPeek">
                  <div class="text-body2 text-kobo-2 q-mb-sm">
                    <q-icon name="info" color="primary" class="q-mr-xs" />
                    {{ $t('createPage.notionPanelChoiceLabel') }}
                  </div>
                  <div class="responsive-fields responsive-fields--sm row q-col-gutter-x-sm">
                    <div class="col-12 col-sm-6">
                      <q-card
                        flat
                        bordered
                        class="peek-card full-height cursor-pointer"
                        :class="{ 'peek-card--active': notionPageChoice === 'panel' }"
                        @click="notionPageChoice = 'panel'"
                      >
                        <q-card-section class="row items-center no-wrap q-gutter-sm q-pa-sm">
                          <q-icon name="article" size="24px" class="peek-card-icon" />
                          <div class="col">
                            <div class="text-body2 text-weight-medium">{{ $t('createPage.notionPanelOption') }}</div>
                            <div class="text-caption text-kobo-3">{{ $t('createPage.notionPanelOptionDesc') }}</div>
                          </div>
                          <q-icon v-if="notionPageChoice === 'panel'" name="check_circle" color="primary" />
                        </q-card-section>
                      </q-card>
                    </div>
                    <div class="col-12 col-sm-6">
                      <q-card
                        flat
                        bordered
                        class="peek-card full-height cursor-pointer"
                        :class="{ 'peek-card--active': notionPageChoice === 'parent' }"
                        @click="notionPageChoice = 'parent'"
                      >
                        <q-card-section class="row items-center no-wrap q-gutter-sm q-pa-sm">
                          <q-icon name="folder_open" size="24px" class="peek-card-icon" />
                          <div class="col">
                            <div class="text-body2 text-weight-medium">{{ $t('createPage.notionParentOption') }}</div>
                            <div class="text-caption text-kobo-3">{{ $t('createPage.notionParentOptionDesc') }}</div>
                          </div>
                          <q-icon v-if="notionPageChoice === 'parent'" name="check_circle" color="primary" />
                        </q-card-section>
                      </q-card>
                    </div>
                  </div>
                </div>
              </div>
            </transition>

            <transition name="slide">
              <div v-if="useSentry" class="source-panel q-pa-md rounded-borders">
                <q-input
                  ref="sentryFieldRef"
                  v-model="sentryUrl"
                  dark
                  outlined
                  dense
                  stack-label
                  :label="$t('createPage.importSentry')"
                  :placeholder="$t('createPage.sentryPlaceholder')"
                  :error="Boolean(sentryUrl.trim()) && !isValidSentryUrl"
                  :error-message="$t('createPage.sentryValidation')"
                  :hint="isValidSentryUrl ? $t('createPage.sentryAutoExtract') : undefined"
                >
                  <template #prepend>
                    <q-icon name="link" :color="isValidSentryUrl ? 'red-4' : 'kobo-3'" />
                  </template>
                </q-input>
              </div>
            </transition>

            <div v-if="showManualSections" class="responsive-fields row q-col-gutter-x-md">
              <div class="col-12 col-md-6">
                <q-expansion-item
                  dark
                  dense
                  expand-separator
                  icon="checklist"
                  :label="$t('createPage.tasks', { count: manualTasks.length })"
                  class="manual-expansion rounded-borders"
                >
                  <div class="q-pa-md column q-gutter-y-sm">
                    <q-input
                      v-model="newManualTask"
                      dark
                      dense
                      outlined
                      :placeholder="$t('createPage.addTask')"
                      @keydown.enter.prevent="addManualTask"
                    >
                      <template #append>
                        <q-btn
                          flat
                          dense
                          round
                          icon="add"
                          color="primary"
                          :disable="!newManualTask.trim()"
                          @click="addManualTask"
                        >
                          <q-tooltip>{{ $t('tooltip.addTask') }}</q-tooltip>
                        </q-btn>
                      </template>
                    </q-input>
                    <div v-if="manualTasks.length" class="row q-gutter-xs">
                      <q-chip
                        v-for="(task, idx) in manualTasks"
                        :key="`task-${idx}`"
                        dark
                        dense
                        removable
                        color="kobo-surface-2"
                        text-color="kobo-1"
                        @remove="removeManualTask(idx)"
                      >
                        {{ task }}
                      </q-chip>
                    </div>
                  </div>
                </q-expansion-item>
              </div>
              <div class="col-12 col-md-6">
                <q-expansion-item
                  dark
                  dense
                  expand-separator
                  icon="fact_check"
                  :label="$t('createPage.acceptanceCriteria', { count: manualCriteria.length })"
                  class="manual-expansion rounded-borders"
                >
                  <div class="q-pa-md column q-gutter-y-sm">
                    <q-input
                      v-model="newManualCriterion"
                      dark
                      dense
                      outlined
                      :placeholder="$t('createPage.addCriterion')"
                      @keydown.enter.prevent="addManualCriterion"
                    >
                      <template #append>
                        <q-btn
                          flat
                          dense
                          round
                          icon="add"
                          color="primary"
                          :disable="!newManualCriterion.trim()"
                          @click="addManualCriterion"
                        >
                          <q-tooltip>{{ $t('tooltip.addCriterion') }}</q-tooltip>
                        </q-btn>
                      </template>
                    </q-input>
                    <div v-if="manualCriteria.length" class="row q-gutter-xs">
                      <q-chip
                        v-for="(criterion, idx) in manualCriteria"
                        :key="`criterion-${idx}`"
                        dark
                        dense
                        removable
                        color="kobo-surface-2"
                        text-color="kobo-1"
                        @remove="removeManualCriterion(idx)"
                      >
                        {{ criterion }}
                      </q-chip>
                    </div>
                  </div>
                </q-expansion-item>
              </div>
            </div>
          </q-card-section>
        </q-card>

        <q-card flat bordered class="create-section-card">
          <q-card-section class="row items-start no-wrap q-gutter-md">
            <q-avatar color="blue-grey-9" text-color="blue-grey-2" icon="account_tree" size="42px" />
            <div>
              <div class="text-subtitle1 text-weight-medium text-kobo-1">{{ $t('createPage.sectionGit') }}</div>
              <div class="text-body2 text-kobo-3">{{ $t('createPage.sectionGitHint') }}</div>
            </div>
          </q-card-section>

          <q-separator dark />

          <q-card-section class="column q-gutter-y-md">
            <div>
              <div class="text-caption text-weight-medium text-kobo-2 q-mb-sm">{{ $t('createPage.worktreeMode') }}</div>
              <q-btn-toggle
                :model-value="useExistingWorktree ? 'existing' : 'new'"
                dense
                spread
                no-caps
                unelevated
                toggle-color="primary"
                color="kobo-surface-2"
                text-color="kobo-2"
                :options="[
                  { label: $t('createPage.worktreeNew'), value: 'new', icon: 'add_box' },
                  { label: $t('createPage.worktreeExisting'), value: 'existing', icon: 'folder_open' },
                ]"
                @update:model-value="setWorktreeMode"
              />
            </div>

            <div class="responsive-fields row q-col-gutter-x-md">
              <div class="col-12 col-md-6">
                <q-select
                  ref="projectFieldRef"
                  v-model="projectPath"
                  :options="pathFilterOptions"
                  dark
                  dense
                  outlined
                  stack-label
                  :error="fieldError === 'projectPath'"
                  :error-message="fieldErrorMessage"
                  use-input
                  fill-input
                  hide-selected
                  input-debounce="0"
                  new-value-mode="add"
                  :label="$t('createPage.projectLabel')"
                  :placeholder="$t('createPage.projectPath')"
                  :behavior="settingsStore.projectPaths.length > 0 ? 'menu' : 'dialog'"
                  :option-label="(opt: string) => (opt ? projectNameForPath(opt) : '')"
                  @filter="filterProjectPaths"
                  @input-value="onProjectPathInput"
                >
                  <template #prepend><q-icon name="folder" /></template>
                  <template #option="{ opt, itemProps }">
                    <q-item v-bind="itemProps">
                      <q-item-section>
                        <q-item-label>{{ projectNameForPath(opt) }}</q-item-label>
                        <q-item-label caption>{{ opt }}</q-item-label>
                      </q-item-section>
                    </q-item>
                  </template>
                  <template #no-option>
                    <q-item><q-item-section class="text-kobo-3">{{ $t('createPage.enterPath') }}</q-item-section></q-item>
                  </template>
                </q-select>
              </div>
              <div class="col-12 col-md-6">
                <q-select
                  ref="branchFieldRef"
                  v-model="branch"
                  :options="branchFilterOptions"
                  dark
                  dense
                  outlined
                  stack-label
                  :error="fieldError === 'branch'"
                  :error-message="fieldErrorMessage"
                  use-input
                  input-debounce="0"
                  :label="$t('createPage.sourceBranch')"
                  :loading="loadingBranches"
                  :disable="!projectPath.trim() || loadingBranches"
                  @filter="filterBranches"
                >
                  <template #prepend><q-icon name="call_split" /></template>
                  <template #no-option>
                    <q-item>
                      <q-item-section class="text-kobo-3">
                        {{ projectPath.trim() ? $t('createPage.noBranches') : $t('createPage.enterPath') }}
                      </q-item-section>
                    </q-item>
                  </template>
                </q-select>
              </div>
            </div>

            <div v-if="!useExistingWorktree" class="responsive-fields row q-col-gutter-x-md">
              <div class="col-12 col-md-4">
                <q-select
                  v-model="branchType"
                  :options="branchTypeOptions"
                  dark
                  dense
                  outlined
                  stack-label
                  emit-value
                  map-options
                  :label="$t('createPage.branchType')"
                >
                  <template #prepend><q-icon name="account_tree" /></template>
                </q-select>
              </div>
              <div class="col-12 col-md-8">
                <q-field dark dense outlined stack-label readonly :label="$t('createPage.workingBranchPreview')">
                  <template #control>
                    <div class="self-center full-width no-outline text-kobo-2 ellipsis" tabindex="0">
                      {{ workingBranchPreview }}
                    </div>
                  </template>
                  <template #prepend><q-icon name="fork_right" /></template>
                </q-field>
              </div>
            </div>

            <q-select
              v-if="useExistingWorktree"
              v-model="selectedWorktreePath"
              :options="orphanWorktrees"
              dark
              dense
              outlined
              stack-label
              option-label="branch"
              option-value="path"
              emit-value
              map-options
              use-input
              :label="$t('createPage.worktreePickerLabel')"
              :loading="loadingOrphanWorktrees"
              :disable="!projectPath.trim() || loadingOrphanWorktrees"
            >
              <template #prepend><q-icon name="folder_open" color="cyan-5" /></template>
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
                  <q-item-section class="text-kobo-3">
                    {{ projectPath.trim() ? $t('createPage.noOrphanWorktrees') : $t('createPage.enterPath') }}
                  </q-item-section>
                </q-item>
              </template>
            </q-select>
          </q-card-section>
        </q-card>

        <q-card flat bordered class="create-section-card">
          <q-card-section class="row items-start no-wrap q-gutter-md">
            <q-avatar color="primary" text-color="white" icon="smart_toy" size="42px" />
            <div class="col">
              <div class="text-subtitle1 text-weight-medium text-kobo-1">{{ $t('createPage.sectionAgent') }}</div>
              <div class="text-body2 text-kobo-3">{{ $t('createPage.sectionAgentHint') }}</div>
            </div>
            <q-toggle
              :model-value="autoLoop"
              dense
              color="amber-6"
              icon="autorenew"
              :label="$t('autoLoop.toggle')"
              left-label
              @update:model-value="toggleAutoLoop"
            />
          </q-card-section>

          <q-separator dark />

          <q-expansion-item
            dark
            dense
            expand-separator
            icon="tune"
            :label="$t('createPage.configureAgent')"
            header-class="agent-config-header"
          >
            <template #header>
              <q-item-section avatar><q-icon name="tune" color="primary" /></q-item-section>
              <q-item-section>
                <q-item-label>{{ $t('createPage.configureAgent') }}</q-item-label>
                <q-item-label caption class="agent-summary row q-gutter-x-xs q-mt-xs">
                  <q-chip dense color="kobo-surface-2" text-color="kobo-1" icon="hub">
                    {{ selectedEngine?.displayName ?? selectedEngineId }}
                  </q-chip>
                  <q-chip dense color="kobo-surface-2" text-color="kobo-1">
                    {{ modelOptions.find((item) => item.value === model)?.label ?? model }}
                  </q-chip>
                  <q-chip dense color="kobo-surface-2" text-color="kobo-1" icon="psychology">
                    {{ reasoningOptions.find((item) => item.value === reasoningEffort)?.label ?? reasoningEffort }}
                  </q-chip>
                  <q-chip dense color="kobo-surface-2" text-color="kobo-1" :icon="agentPermissionModeIcon">
                    {{
                      agentPermissionModeOptions.find((item) => item.value === resolvedOverrides.agentPermissionMode)
                        ?.label ?? resolvedOverrides.agentPermissionMode
                    }}
                  </q-chip>
                </q-item-label>
              </q-item-section>
            </template>

            <q-card-section class="responsive-fields row q-col-gutter-x-md q-pt-md">
              <div v-if="engineSelectOptions.length > 0" class="col-12 col-sm-6">
                <q-select
                  v-model="selectedEngineId"
                  :options="engineSelectOptions"
                  dark
                  dense
                  outlined
                  stack-label
                  emit-value
                  map-options
                  option-value="value"
                  option-label="label"
                  :label="$t('engine.select')"
                />
              </div>
              <div class="col-12 col-sm-6">
                <q-select
                  v-model="model"
                  :options="modelOptions"
                  dark
                  dense
                  outlined
                  stack-label
                  emit-value
                  map-options
                  option-value="value"
                  option-label="label"
                  :label="$t('engine.model')"
                >
                  <template #option="{ opt, itemProps }">
                    <q-item v-bind="itemProps">
                      <q-item-section>
                        <q-item-label>{{ opt.label }}</q-item-label>
                        <q-item-label caption>{{ opt.description }}</q-item-label>
                      </q-item-section>
                    </q-item>
                  </template>
                </q-select>
              </div>
              <div class="col-12 col-sm-6">
                <q-select
                  v-model="reasoningEffort"
                  :options="reasoningOptions"
                  dark
                  dense
                  outlined
                  stack-label
                  emit-value
                  map-options
                  option-value="value"
                  option-label="label"
                  :label="$t('engine.effort')"
                >
                  <template #option="{ opt, itemProps }">
                    <q-item v-bind="itemProps">
                      <q-item-section>
                        <q-item-label>{{ opt.label }}</q-item-label>
                        <q-item-label caption>{{ opt.description }}</q-item-label>
                      </q-item-section>
                    </q-item>
                  </template>
                </q-select>
              </div>
              <div class="col-12 col-sm-6">
                <q-select
                  :model-value="resolvedOverrides.agentPermissionMode"
                  :options="agentPermissionModeOptions"
                  dark
                  dense
                  outlined
                  stack-label
                  emit-value
                  map-options
                  option-value="value"
                  option-label="label"
                  :option-disable="isOptionDisabled"
                  :disable="autoLoop"
                  :label="$t('agentPermissionMode.label')"
                  :hint="autoLoop ? $t('agentPermissionMode.autoLoopLocked') : undefined"
                  @update:model-value="(val) => (agentPermissionMode = val as AgentPermissionMode)"
                />
              </div>
            </q-card-section>
          </q-expansion-item>

          <transition name="slide">
            <q-card-section v-if="autoLoop" class="auto-loop-panel column">
              <div class="text-subtitle2 text-amber-3">{{ $t('autoLoop.startInMode') }}</div>
              <q-btn-toggle
                v-model="autoLoopSessionMode"
                dense
                size="sm"
                spread
                no-caps
                unelevated
                class="auto-loop-session-toggle"
                toggle-color="primary"
                color="kobo-surface-2"
                text-color="kobo-2"
                :options="[
                  { label: $t('autoLoop.sessionMode.perTask'), value: 'per_task', icon: 'restart_alt' },
                  { label: $t('autoLoop.sessionMode.continuous'), value: 'continuous', icon: 'link' },
                ]"
              />
              <div class="responsive-fields row q-col-gutter-x-md">
                <div class="col-12 col-sm-6">
                  <q-select
                    v-model="brainstormModel"
                    :options="modelOptions"
                    dark
                    dense
                    outlined
                    stack-label
                    emit-value
                    map-options
                    option-value="value"
                    option-label="label"
                    :label="$t('autoLoop.brainstormModelPrefix')"
                  />
                </div>
                <div class="col-12 col-sm-6">
                  <q-select
                    v-model="brainstormReasoningEffort"
                    :options="reasoningOptions"
                    dark
                    dense
                    outlined
                    stack-label
                    emit-value
                    map-options
                    option-value="value"
                    option-label="label"
                    :label="$t('autoLoop.brainstormReasoningPrefix')"
                  />
                </div>
              </div>
            </q-card-section>
          </transition>
        </q-card>

        <q-expansion-item
          dark
          dense
          expand-separator
          icon="settings"
          :label="$t('createPage.advancedOptions')"
          class="advanced-options rounded-borders"
        >
          <q-card-section>
            <q-toggle
              v-model="skipSetupScript"
              dense
              color="orange-5"
              icon="play_disabled"
              :label="$t('createPage.skipSetupScript')"
              :disable="useExistingWorktree"
            />
          </q-card-section>
        </q-expansion-item>

        <q-card flat bordered class="create-actions-card">
          <q-card-section class="row items-center justify-between q-gutter-md">
            <div class="text-caption text-kobo-3">
              {{ useNotion ? $t('createPage.notionExtractHint') : $t('createPage.keyboardHint') }}
            </div>
            <div class="row q-gutter-sm create-actions">
              <q-btn flat dense no-caps color="kobo-2" :label="$t('common.cancel')" @click="router.back()" />
              <q-btn
                unelevated
                dense
                no-caps
                color="primary"
                icon-right="arrow_forward"
                :label="$t('createPage.createWorkspace')"
                :loading="submitting"
                :disable="submitting || (useExistingWorktree && !selectedWorktreePath)"
                @click="handleCreate"
              />
            </div>
          </q-card-section>

          <q-card-section v-if="submitting && creationStepLabel" class="create-page__progress text-caption q-pt-none">
            <q-spinner-dots size="18px" />
            <span class="create-page__progress-step">{{ creationStepLabel }}</span>
            <span v-if="creationStepCounter" class="create-page__progress-counter">{{ creationStepCounter }}</span>
          </q-card-section>
        </q-card>
      </div>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import type { QInput } from 'quasar'
import { useQuasar } from 'quasar'
import DrawerToggleButton from 'src/components/DrawerToggleButton.vue'
import SlashSuggestionsPopup from 'src/components/SlashSuggestionsPopup.vue'
import { type SlashDropdownItem, useSlashAutocomplete } from 'src/composables/use-slash-autocomplete'
import { EFFORT_OPTION_DEFS_BY_ENGINE } from 'src/constants/efforts'
import { MODEL_OPTION_DEFS, MODEL_OPTION_DEFS_BY_ENGINE } from 'src/constants/models'
import { PERMISSION_MODES_BY_ENGINE } from 'src/constants/permissionModes'
import { useSettingsStore } from 'src/stores/settings'
import { useTemplatesStore } from 'src/stores/templates'
import { useWebSocketStore } from 'src/stores/websocket'
import { useWorkspaceStore } from 'src/stores/workspace'
import { resolveCreateOverrides } from 'src/utils/create-overrides'
import { loadCreatePagePrefs, saveCreatePagePrefs } from 'src/utils/create-page-prefs'
import { buildTemplateVars, expandTemplate } from 'src/utils/expand-template'
import { playNotificationSound } from 'src/utils/notifications'
import { projectNameForPath } from 'src/utils/project-color'
import { registerUnsavedScope, unregisterUnsavedScope } from 'src/utils/unsaved-guard'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

/**
 * QSelect `:option-disable` predicate. Kept in the script (not inline in the
 * template) because vue-tsc/Volar can't parse an inline object-type annotation
 * on an arrow function inside a template attribute — it errored at the `{` of
 * the type literal.
 */
function isOptionDisabled(opt: { disabled?: boolean }): boolean {
  return opt.disabled === true
}

interface EngineDto {
  id: string
  displayName: string
  capabilities: {
    models: Array<{ id: string; label: string }>
    effortLevels?: Array<{ id: string; label: string }>
    permissionModes: Array<'plan' | 'bypass' | 'strict' | 'interactive'>
    supportsResume: boolean
    supportsMcp: boolean
    supportsSkills: boolean
  }
}

const router = useRouter()
const $q = useQuasar()
const store = useWorkspaceStore()
const settingsStore = useSettingsStore()
const { t, te } = useI18n()

const pathFilterOptions = ref<string[]>([])

// Form fields
const workspaceName = ref('')
const description = ref('')
const descriptionRef = ref<QInput | null>(null)
// Tracks the last project task-prompt auto-injected into `description`. Used to
// tell an untouched injected prompt (safe to replace) from user-typed content.
const injectedProjectPrompt = ref('')
const isCreateVoiceRecording = ref(false)
const isCreateVoiceTranscribing = ref(false)
const createVoiceRecorderRef = ref<MediaRecorder | null>(null)
const createVoiceStreamRef = ref<MediaStream | null>(null)
const createVoiceChunksRef = ref<BlobPart[]>([])
const createVoiceTimeoutRef = ref<ReturnType<typeof setTimeout> | null>(null)
const CREATE_VOICE_MAX_MS = 60_000
const notionUrl = ref('')
const useNotion = ref(false)
const model = ref('claude-opus-4-8')
// Model used only for the initial brainstorming session when auto-loop is
// on. Mirrors `model` at the moment auto-loop is switched on (see
// toggleAutoLoop below); untouched afterwards unless the user picks a
// different value in its own select.
const brainstormModel = ref('claude-opus-4-8')
const brainstormReasoningEffort = ref('auto')
const reasoningEffort = ref('auto')
const reasoningEffortByModel = ref<Record<string, string>>({})
const projectPath = ref('')
const branch = ref<string | null>(null)
const branchType = ref('feature')
const skipSetupScript = ref(false)
const createVoiceEnabled = computed(() => settingsStore.global.voiceEnabled)

// Engine selector state — engine list is loaded from `/api/engines` on mount.
const engines = ref<EngineDto[]>([])
const selectedEngineId = ref<string>('claude-code')
const selectedEngine = computed<EngineDto | undefined>(() => engines.value.find((e) => e.id === selectedEngineId.value))
const engineSelectOptions = computed(() => engines.value.map((e) => ({ value: e.id, label: e.displayName })))
// Branch prefix options are user-managed in global settings (stored without
// the trailing `/`). The select emits the bare prefix; `/` is added at display
// time and when composing the working branch (`<prefix>/<slug>`).
const branchTypeOptions = computed(() => settingsStore.global.branchPrefixes.map((p) => ({ label: `${p}/`, value: p })))

type AgentPermissionMode = 'plan' | 'bypass' | 'strict' | 'interactive'

const ALL_AGENT_PERMISSION_MODES: AgentPermissionMode[] = ['plan', 'bypass', 'strict', 'interactive']

/**
 * Derive the default unified permission mode for a workspace being created.
 *
 * Cascade:
 *   1. Per-project `agentPermissionMode` setting (if defined for this path).
 *   2. Global per-engine `defaultPermissionModeByEngine[engineId]` setting.
 *   3. Legacy fallback: `dangerouslySkipPermissions` → 'bypass' / 'interactive'.
 *   4. Hard fallback: 'bypass'.
 *
 * The engine id is needed because Codex doesn't honour `'interactive'` — the
 * per-engine map ensures the picked value is compatible with the selected
 * engine.
 */
function deriveDefaultAgentPermissionMode(projectPath: string, engineId: string): AgentPermissionMode {
  const project = projectPath ? settingsStore.getProjectByPath(projectPath) : undefined
  const projectMode = (project as { agentPermissionMode?: unknown } | null)?.agentPermissionMode
  if (typeof projectMode === 'string' && (ALL_AGENT_PERMISSION_MODES as string[]).includes(projectMode)) {
    return projectMode as AgentPermissionMode
  }
  const global = settingsStore.global.defaultPermissionModeByEngine?.[engineId]
  if (typeof global === 'string' && (ALL_AGENT_PERMISSION_MODES as string[]).includes(global)) {
    return global as AgentPermissionMode
  }
  // Legacy fallback for installs that only ever saw the boolean toggle.
  const skip =
    (project as { dangerouslySkipPermissions?: boolean } | null)?.dangerouslySkipPermissions ??
    settingsStore.global.dangerouslySkipPermissions ??
    true
  // Honour engine compatibility: Codex cannot use 'interactive' even on the
  // legacy path, so the false branch picks 'plan' (the safest restrictive mode)
  // when the engine doesn't support 'interactive'.
  if (skip) return 'bypass'
  return engineId === 'codex' ? 'plan' : 'interactive'
}

const agentPermissionMode = ref<AgentPermissionMode>(deriveDefaultAgentPermissionMode('', selectedEngineId.value))

const agentPermissionModeIcon = computed<string>(() => {
  switch (resolvedOverrides.value.agentPermissionMode) {
    case 'plan':
      return 'visibility'
    case 'bypass':
      return 'flash_on'
    case 'strict':
      return 'lock'
    case 'interactive':
      return 'security'
  }
})

// 'plan' is disabled when auto-loop is on — picking it would deadlock the loop.
// Driven by the local per-engine constant to avoid a flicker before
// `/api/engines` returns; the backend capabilities still validate at POST time.
const agentPermissionModeOptions = computed(() => {
  const supported = PERMISSION_MODES_BY_ENGINE[selectedEngineId.value] ?? ALL_AGENT_PERMISSION_MODES
  return supported.map((value) => ({
    value,
    label: t(`agentPermissionMode.${value}`),
    disabled: value === 'plan' && autoLoop.value,
  }))
})

// State
const branches = ref<string[]>([])
const branchFilterOptions = ref<string[]>([])
const loadingBranches = ref(false)
const submitting = ref(false)
const creationId = ref<string | null>(null)

/** Human label for the step the server is currently on. Empty when idle. */
const creationStepLabel = computed(() => {
  const progress = store.creationProgress
  if (!progress || progress.creationId !== creationId.value) return ''
  const key = `createPage.progress.${progress.step}`
  // Steps are server-defined and may grow over time (or briefly be a step
  // name this build doesn't know yet, right after an upgrade). Fall back to
  // the raw step id rather than showing nothing or throwing.
  return te(key) ? t(key) : progress.step
})

const creationStepCounter = computed(() => {
  const progress = store.creationProgress
  if (!progress || progress.creationId !== creationId.value || progress.index < 0) return ''
  return t('createPage.progress.step', { index: progress.index + 1, total: progress.total })
})

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

async function startCreateVoiceCapture() {
  if (!createVoiceEnabled.value || isCreateVoiceRecording.value || isCreateVoiceTranscribing.value) return
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    $q.notify({ type: 'warning', message: t('voice.notSupported'), position: 'top', timeout: 4000 })
    return
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    createVoiceStreamRef.value = stream
    createVoiceChunksRef.value = []
    const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : ''
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) createVoiceChunksRef.value.push(event.data)
    }
    recorder.start()
    createVoiceRecorderRef.value = recorder
    isCreateVoiceRecording.value = true
    createVoiceTimeoutRef.value = setTimeout(() => {
      void stopCreateVoiceCapture()
      $q.notify({ type: 'info', message: t('voice.maxDurationReached'), position: 'top', timeout: 3500 })
    }, CREATE_VOICE_MAX_MS)
  } catch {
    $q.notify({ type: 'negative', message: t('voice.errorMicPermission'), position: 'top', timeout: 5000 })
  }
}

async function stopCreateVoiceCapture() {
  if (!isCreateVoiceRecording.value) return
  const recorder = createVoiceRecorderRef.value
  if (!recorder) return
  isCreateVoiceRecording.value = false
  isCreateVoiceTranscribing.value = true
  if (createVoiceTimeoutRef.value) {
    clearTimeout(createVoiceTimeoutRef.value)
    createVoiceTimeoutRef.value = null
  }
  const blob = await new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(createVoiceChunksRef.value, { type: 'audio/webm' }))
    recorder.stop()
  })
  try {
    if (blob.size === 0) throw new Error('MIC_AUDIO_INVALID')
    const fd = new FormData()
    fd.append('audio', blob, 'voice.webm')
    fd.append('language', settingsStore.global.voiceLanguage || 'auto')
    const res = await fetch('/api/voice/transcribe', { method: 'POST', body: fd })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(String(body.code ?? body.error ?? `HTTP_${res.status}`))
    }
    const data = (await res.json()) as { text: string }
    if (data.text?.trim())
      description.value = description.value ? `${description.value.trimEnd()} ${data.text.trim()}` : data.text.trim()
  } catch (err) {
    const code = err instanceof Error ? err.message : 'TRANSCRIPTION_FAILED'
    const map: Record<string, string> = {
      VOICE_DISABLED: 'voice.errorDisabled',
      MODEL_NOT_CONFIGURED: 'voice.errorModelMissing',
      MODEL_NOT_INSTALLED: 'voice.errorModelNotInstalled',
      VOICE_RUNTIME_MISSING: 'voice.errorRuntimeMissing',
      MIC_AUDIO_INVALID: 'voice.errorAudioInvalid',
      LANGUAGE_INVALID: 'voice.errorLanguageInvalid',
      TRANSCRIPTION_TIMEOUT: 'voice.errorTranscription',
    }
    $q.notify({ type: 'negative', message: t(map[code] ?? 'voice.errorTranscription'), position: 'top', timeout: 5000 })
  } finally {
    createVoiceRecorderRef.value = null
    createVoiceChunksRef.value = []
    createVoiceStreamRef.value?.getTracks().forEach((t) => {
      t.stop()
    })
    createVoiceStreamRef.value = null
    isCreateVoiceTranscribing.value = false
  }
}

function shouldHandleCreatePtt(event: KeyboardEvent): boolean {
  if (!createVoiceEnabled.value) return false
  const key = settingsStore.global.voicePttKey
  if (key === 'ctrl+space') return event.ctrlKey && event.code === 'Space'
  return event.key === 'Alt'
}

function onCreateWindowKeyDown(event: KeyboardEvent) {
  if (!shouldHandleCreatePtt(event) || event.repeat) return
  event.preventDefault()
  void startCreateVoiceCapture()
}

function onCreateWindowKeyUp(event: KeyboardEvent) {
  if (!shouldHandleCreatePtt(event)) return
  event.preventDefault()
  void stopCreateVoiceCapture()
}

function onCreateWindowBlur() {
  if (isCreateVoiceRecording.value) void stopCreateVoiceCapture()
}

function onCreateVisibilityChange() {
  if (document.visibilityState !== 'visible' && isCreateVoiceRecording.value) {
    void stopCreateVoiceCapture()
  }
}

// Model options — derived from the per-engine catalogue in
// `src/constants/models.ts` (which mirrors the shared shared/*-models.ts
// definitions). Server-side capabilities are used only for validation in
// `POST /api/workspaces`, not for UI rendering. Falls back to Claude's
// catalogue if the engine id isn't recognised (e.g. third-party engine
// added server-side before the frontend ships the matching list).
const modelOptions = computed(() => {
  const defs = MODEL_OPTION_DEFS_BY_ENGINE[selectedEngineId.value] ?? MODEL_OPTION_DEFS
  return defs.map((option) => ({
    label: t(option.i18nLabelKey),
    value: option.value,
    description: t(option.i18nDescriptionKey),
  }))
})

// When the user switches engine, apply the per-engine default model from
// global settings if it's part of the new catalogue. Falls back to 'auto' if
// neither the current value nor the configured default is compatible.
// Also re-derives the permission mode so a value incompatible with the new
// engine (e.g. 'interactive' under Codex) is replaced by the engine's
// configured default.
watch(selectedEngineId, () => {
  const validIds = modelOptions.value.map((m) => m.value)
  if (validIds.length > 0) {
    const globalDefault = settingsStore.global.defaultModelByEngine?.[selectedEngineId.value]
    if (typeof globalDefault === 'string' && validIds.includes(globalDefault)) {
      model.value = globalDefault
    } else if (!validIds.includes(model.value)) {
      model.value = validIds.includes('auto') ? 'auto' : (validIds[0] ?? 'auto')
    }
  }
  if (validIds.length > 0 && !validIds.includes(brainstormModel.value)) {
    brainstormModel.value = validIds.includes('auto') ? 'auto' : (validIds[0] ?? 'auto')
  }
  const supportedModes = PERMISSION_MODES_BY_ENGINE[selectedEngineId.value] ?? []
  if (supportedModes.length > 0 && !supportedModes.includes(agentPermissionMode.value)) {
    agentPermissionMode.value = deriveDefaultAgentPermissionMode(projectPath.value, selectedEngineId.value)
  }
  // Reasoning effort: drop a value that isn't supported by the new engine
  // (e.g. 'max' under Codex, or 'minimal' under Claude). Falls back to 'auto'.
  const supportedEfforts = (EFFORT_OPTION_DEFS_BY_ENGINE[selectedEngineId.value] ?? []).map((e) => e.value)
  if (supportedEfforts.length > 0 && !supportedEfforts.includes(reasoningEffort.value)) {
    reasoningEffort.value = supportedEfforts.includes('auto') ? 'auto' : (supportedEfforts[0] ?? 'auto')
  }
})

function formatReasoningLabel(label: string): string {
  const separatorIndex = label.indexOf(':')
  if (separatorIndex >= 0) return label.slice(separatorIndex + 1).trim()
  return label
}

// Reasoning effort options — driven by the per-engine catalogue in
// `src/constants/efforts.ts` (mirror of backend `capabilities.effortLevels`).
// Using local constants avoids a render flicker while `/api/engines` is in
// flight. Labels/descriptions stay engine-agnostic via the shared i18n keys
// `reasoning.<id>` / `reasoning.<id>Description`.
const reasoningOptions = computed(() => {
  const defs = EFFORT_OPTION_DEFS_BY_ENGINE[selectedEngineId.value] ?? EFFORT_OPTION_DEFS_BY_ENGINE['claude-code']
  return defs.map((d) => ({
    value: d.value,
    label: formatReasoningLabel(t(d.i18nLabelKey)),
    description: t(d.i18nDescriptionKey),
  }))
})

watch(model, (selectedModel) => {
  const savedEffort = reasoningEffortByModel.value[selectedModel]
  if (savedEffort && reasoningOptions.value.some((option) => option.value === savedEffort)) {
    reasoningEffort.value = savedEffort
  }
})

watch(reasoningEffort, (effort) => {
  reasoningEffortByModel.value = { ...reasoningEffortByModel.value, [model.value]: effort }
  saveCreatePagePrefs({ ...loadCreatePagePrefs(), reasoningEffortByModel: reasoningEffortByModel.value })
})

// Validate Notion URL
// Notion has two URL flavours in the wild — keep both:
//   - legacy  https://www.notion.so/...
//   - new     https://app.notion.com/p/<workspace>/<title>-<32hex>
// Backend `parseNotionUrl` already handles both shapes (it just looks for the
// trailing 32-hex chunk), so we only need to widen the client-side prefix check.
const isValidNotionUrl = computed(() => {
  const u = notionUrl.value.trim()
  return u.startsWith('https://www.notion.so/') || u.startsWith('https://app.notion.com/')
})

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
const autoLoopSessionMode = ref<'per_task' | 'continuous'>('per_task')
// NOTE: auto-loop no longer mutates `agentPermissionMode` directly. Doing so
// used to permanently clobber the user's stored preference (e.g. 'plan')
// with 'bypass' the moment auto-loop was enabled, so turning auto-loop back
// off could never restore what the user actually picked. `resolvedOverrides`
// (see below) now derives the effective, send-to-server mode from the raw
// preference + autoLoop on every read — for both the request payload and
// everywhere the mode is displayed — without ever touching the ref itself.

function toggleAutoLoop() {
  autoLoop.value = !autoLoop.value
  // Seed the brainstorm-model select with the current execution model so
  // leaving it untouched is a no-op (same model everywhere, today's
  // behavior). Only runs on a real user click — NOT during the onMounted
  // prefs restore below, which sets `autoLoop.value` directly and restores
  // `brainstormModel` from localStorage instead.
  if (autoLoop.value) {
    brainstormModel.value = model.value
  }
}
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

// Single source of truth for both silent overrides this form applies
// (forced skip-setup-script on worktree reuse, plan->bypass under auto-loop).
// The template and the request payload both read from here, so what the UI
// displays can never drift from what actually goes out over the wire.
const resolvedOverrides = computed(() =>
  resolveCreateOverrides({
    useExistingWorktree: useExistingWorktree.value,
    skipSetupScript: skipSetupScript.value,
    autoLoop: autoLoop.value,
    agentPermissionMode: agentPermissionMode.value,
  }),
)

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

function setWorktreeMode(mode: string | number | null) {
  const shouldUseExisting = mode === 'existing'
  if (shouldUseExisting !== useExistingWorktree.value) toggleExistingWorktree()
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
    // Inject the project's custom task prompt into the description textarea —
    // but only when the user hasn't typed their own content (textarea empty or
    // still holding the previously-injected prompt verbatim).
    const taskPrompt = project.taskPromptTemplate ?? ''
    if (description.value === '' || description.value === injectedProjectPrompt.value) {
      description.value = taskPrompt
      injectedProjectPrompt.value = taskPrompt
    }
    // Pick a model that's valid for the currently selected engine. Cascade:
    //   1. Project default (if in the engine's catalogue)
    //   2. Global per-engine default
    //   3. Leave model untouched (CreatePage's engine watcher already keeps
    //      it consistent with the selected engine).
    const validIds = modelOptions.value.map((m) => m.value)
    if (project.defaultModel && validIds.includes(project.defaultModel)) {
      model.value = project.defaultModel
    } else {
      const globalDefault = settingsStore.global.defaultModelByEngine?.[selectedEngineId.value]
      if (typeof globalDefault === 'string' && validIds.includes(globalDefault)) {
        model.value = globalDefault
      }
    }
  }
  agentPermissionMode.value = deriveDefaultAgentPermissionMode(path, selectedEngineId.value)
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

// Filter project paths for the q-select. The field now displays project names,
// so match against both the path and the resolved name (covers custom display
// names that differ from the folder basename).
function filterProjectPaths(val: string, update: (fn: () => void) => void) {
  const needle = val.toLowerCase()
  update(() => {
    pathFilterOptions.value = settingsStore.projectPaths.filter(
      (p) => p.toLowerCase().includes(needle) || projectNameForPath(p).toLowerCase().includes(needle),
    )
  })
}

// The repo q-select shows the project NAME (via :option-label), so `fill-input`
// writes that name into the field on selection — and Quasar emits it through
// @input-value. Map a known project name back to its absolute path so the model
// stays canonical; a real path the user types contains slashes and never equals
// a name, so it passes through unchanged (custom-path entry still works).
function onProjectPathInput(val: string) {
  const known = settingsStore.projectPaths.find((p) => projectNameForPath(p) === val)
  projectPath.value = known ?? val
}

// Fetch settings + available engines on mount. The engine list powers the
// engine selector and drives the model / effort / permission options.
onMounted(async () => {
  // Await settings before engines so permission-mode derivation sees the
  // project list. Re-derive after to fix a possible race with applyProjectDefaults.
  await settingsStore.fetchSettings()

  // Default the branch-type selector to the first configured prefix when the
  // current value isn't part of the user's list (e.g. legacy 'feature' default
  // but the user renamed/removed it).
  const branchPrefixes = settingsStore.global.branchPrefixes
  if (branchPrefixes.length > 0 && !branchPrefixes.includes(branchType.value)) {
    branchType.value = branchPrefixes[0]
  }

  // Restore last-used inputs from localStorage. The projectPath is only
  // restored when it's still a known project — a stale path silently falls
  // back to empty rather than re-displaying a dead value.
  const prefs = loadCreatePagePrefs()
  reasoningEffortByModel.value = prefs.reasoningEffortByModel ?? {}
  if (prefs.autoLoop === true) {
    autoLoop.value = true
  }
  if (prefs.autoLoopSessionMode === 'continuous') {
    autoLoopSessionMode.value = 'continuous'
  }
  if (prefs.autoLoop === true && prefs.brainstormModel) {
    brainstormModel.value = prefs.brainstormModel
  }
  if (prefs.projectPath && settingsStore.projectPaths.includes(prefs.projectPath)) {
    projectPath.value = prefs.projectPath
  }

  agentPermissionMode.value = deriveDefaultAgentPermissionMode(projectPath.value, selectedEngineId.value)
  try {
    const res = await fetch('/api/engines')
    if (res.ok) {
      engines.value = (await res.json()) as EngineDto[]
    }
  } catch {
    // Best-effort: the legacy hardcoded fallback keeps the form usable.
  }

  // Apply the per-engine global default model now that both settings and
  // engines have loaded. The engine-change watcher only fires on switch, so we
  // run the same logic once at mount for the initially-selected engine.
  {
    const validIds = modelOptions.value.map((m) => m.value)
    const globalDefault = settingsStore.global.defaultModelByEngine?.[selectedEngineId.value]
    if (typeof globalDefault === 'string' && validIds.includes(globalDefault)) {
      model.value = globalDefault
    } else if (validIds.length > 0 && !validIds.includes(model.value)) {
      model.value = validIds.includes('auto') ? 'auto' : (validIds[0] ?? 'auto')
    }
  }
  const savedEffort = reasoningEffortByModel.value[model.value]
  if (savedEffort && reasoningOptions.value.some((option) => option.value === savedEffort)) {
    reasoningEffort.value = savedEffort
  }
  {
    const validIds = modelOptions.value.map((m) => m.value)
    if (validIds.length > 0 && !validIds.includes(brainstormModel.value)) {
      brainstormModel.value = validIds.includes('auto') ? 'auto' : (validIds[0] ?? 'auto')
    }
  }
  window.addEventListener('keydown', onCreateWindowKeyDown)
  window.addEventListener('keyup', onCreateWindowKeyUp)
  window.addEventListener('blur', onCreateWindowBlur)
  document.addEventListener('visibilitychange', onCreateVisibilityChange)
  // Only a form the user actually filled in is worth defending — a pristine
  // page must never prompt.
  registerUnsavedScope(
    'create:form',
    () =>
      !submitting.value &&
      (description.value.trim().length > 0 || manualTasks.value.length > 0 || manualCriteria.value.length > 0),
  )
})

// Cleanup debounce timer on unmount
onUnmounted(() => {
  if (pathDebounce) clearTimeout(pathDebounce)
  window.removeEventListener('keydown', onCreateWindowKeyDown)
  window.removeEventListener('keyup', onCreateWindowKeyUp)
  window.removeEventListener('blur', onCreateWindowBlur)
  document.removeEventListener('visibilitychange', onCreateVisibilityChange)
  unregisterUnsavedScope('create:form')
  if (createVoiceTimeoutRef.value) {
    clearTimeout(createVoiceTimeoutRef.value)
    createVoiceTimeoutRef.value = null
  }
  if (isCreateVoiceRecording.value) void stopCreateVoiceCapture()
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

const workingBranchPreview = computed(() => {
  if (useNotion.value && isValidNotionUrl.value) {
    return `${branchType.value}/${branchNameFromNotionUrl(getEffectiveNotionUrl())}`
  }
  const name = getFinalName()
  const slug = name === 'workspace' ? t('createPage.branchNamePending') : toKebabCase(name)
  return `${branchType.value}/${slug}`
})

// ── Validation par champ ─────────────────────────────────────────────────────
// La validation ne produisait qu'une notification : sur une page de ~2 000 px
// de haut, l'utilisateur lisait le message sans savoir OÙ corriger. On marque
// donc le champ fautif et on défile jusqu'à lui.
type CreateField = 'name' | 'description' | 'notionUrl' | 'sentryUrl' | 'projectPath' | 'branch'

const fieldError = ref<CreateField | null>(null)
const fieldErrorMessage = ref('')

const nameFieldRef = ref<{ $el?: HTMLElement; focus?: () => void } | null>(null)
const notionFieldRef = ref<{ $el?: HTMLElement; focus?: () => void } | null>(null)
const sentryFieldRef = ref<{ $el?: HTMLElement; focus?: () => void } | null>(null)
const projectFieldRef = ref<{ $el?: HTMLElement; focus?: () => void } | null>(null)
const branchFieldRef = ref<{ $el?: HTMLElement; focus?: () => void } | null>(null)

function fieldRefFor(field: CreateField) {
  switch (field) {
    case 'name':
      return nameFieldRef.value
    case 'description':
      return descriptionRef.value
    case 'notionUrl':
      return notionFieldRef.value
    case 'sentryUrl':
      return sentryFieldRef.value
    case 'projectPath':
      return projectFieldRef.value
    case 'branch':
      return branchFieldRef.value
  }
}

/** Marquer, faire défiler jusqu'au champ, puis lui donner le focus. */
async function revealField(field: CreateField, message: string): Promise<void> {
  fieldError.value = field
  fieldErrorMessage.value = message
  await nextTick()
  const target = fieldRefFor(field)
  const el = (target as { $el?: HTMLElement } | null)?.$el ?? (target as unknown as HTMLElement | null)
  // `block: 'center'` plutôt que `'start'` : le champ ne se retrouve pas collé
  // sous l'en-tête collant.
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  ;(target as { focus?: () => void } | null)?.focus?.()
}

/** Effacer le marquage dès que l'utilisateur touche à quoi que ce soit. */
watch([workspaceName, description, notionUrl, sentryUrl, projectPath, branch], () => {
  if (fieldError.value !== null) {
    fieldError.value = null
    fieldErrorMessage.value = ''
  }
})

// Form validation — retourne le CHAMP fautif en plus du message, pour que
// l'appelant puisse le marquer et défiler jusqu'à lui.
function validate(): { field: CreateField; message: string } | null {
  if (useNotion.value && !isValidNotionUrl.value) {
    return { field: 'notionUrl', message: t('createPage.validationNotionUrl') }
  }
  if (useSentry.value && !isValidSentryUrl.value) {
    return { field: 'sentryUrl', message: t('createPage.sentryValidation') }
  }
  // Description is optional when Notion or Sentry provides the workspace context
  if (!useNotion.value && !useSentry.value && !description.value.trim()) {
    return { field: 'description', message: t('createPage.validationDescription') }
  }
  if (!useNotion.value && !useSentry.value && (!getFinalName() || getFinalName() === 'workspace')) {
    if (!workspaceName.value.trim() && !description.value.trim()) {
      return { field: 'name', message: t('createPage.validationName') }
    }
  }
  if (!projectPath.value.trim()) {
    return { field: 'projectPath', message: t('createPage.validationPath') }
  }
  if (!branch.value) {
    return { field: 'branch', message: t('createPage.validationBranch') }
  }
  return null
}

// Submit form
async function handleCreate() {
  // The Ctrl/Cmd+Enter shortcut calls this directly, bypassing the submit
  // button's `:disable="submitting"` — guard here too, or a key-repeat /
  // fast double-press fires two concurrent POST /api/workspaces calls,
  // creating two duplicate workspaces from one user action.
  if (submitting.value) return

  const error = validate()
  if (error) {
    $q.notify({
      type: 'negative',
      message: `${error.message} — ${t('createPage.validationFocusHint')}`,
      position: 'top',
    })
    void revealField(error.field, error.message)
    return
  }

  if (useExistingWorktree.value && !selectedWorktreePath.value) {
    $q.notify({ type: 'negative', message: t('createPage.pickWorktreeRequired'), position: 'top' })
    return
  }

  submitting.value = true
  // Subscribe BEFORE posting: the first progress beats are emitted while the
  // POST is still in flight, and an unsubscribed channel drops them silently.
  const wsStoreForProgress = useWebSocketStore()
  const newCreationId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? `create-${crypto.randomUUID()}`
      : `create-${Date.now()}-${Math.random().toString(36).slice(2)}`
  creationId.value = newCreationId
  store.clearCreationProgress()
  wsStoreForProgress.subscribeChannel(newCreationId)
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
      creationId: newCreationId,
      // Reuse-an-existing-worktree branch: skip generating a workingBranch
      // (backend ignores it when worktreePath is set). skipSetupScript is
      // resolved once, below, via `resolvedOverrides`.
      // Standard branch: keep the generated workingBranch as before.
      ...(useExistingWorktree.value && selectedWorktreePath.value
        ? { worktreePath: selectedWorktreePath.value, workingBranch }
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
      ...(resolvedOverrides.value.skipSetupScript ? { skipSetupScript: true } : {}),
      ...(description.value.trim() ? { description: description.value.trim() } : {}),
      ...(autoLoop.value
        ? {
            autoLoop: true,
            autoLoopSessionMode: autoLoopSessionMode.value,
            brainstormModel: brainstormModel.value,
            brainstormReasoningEffort: brainstormReasoningEffort.value,
          }
        : {}),
      // Resolved in exactly one place (utils/create-overrides) so what the page
      // displays and what the request carries can never drift apart.
      agentPermissionMode: resolvedOverrides.value.agentPermissionMode,
    }

    const workspace = await store.createWorkspace(payload)

    if (settingsStore.global.audioWorkspaceCreatedNotifications) {
      playNotificationSound(
        settingsStore.global.audioWorkspaceCreatedSound,
        settingsStore.global.audioWorkspaceCreatedVolume,
      )
    }

    // The server appends a `-<HASH>` suffix when the requested branch / path
    // collides with an existing one. Surface that so the user knows why the
    // sidebar shows a slightly different branch name.
    if ((workspace as { _branchAdjusted?: boolean })._branchAdjusted) {
      $q.notify({
        type: 'info',
        message: t('createPage.branchAdjusted', { branch: workspace.workingBranch }),
        position: 'top',
        timeout: 6000,
      })
    }

    if ((workspace as { _sourceFallback?: boolean })._sourceFallback) {
      $q.notify({
        type: 'warning',
        message: t('createPage.localSourceFallback'),
        position: 'top',
        timeout: 6000,
      })
    }

    // Persist last-used inputs so the next Create-workspace visit pre-fills
    // them. Run only after a successful create — failures keep the previous
    // saved values intact.
    saveCreatePagePrefs({
      projectPath: projectPath.value.trim(),
      autoLoop: autoLoop.value,
      autoLoopSessionMode: autoLoopSessionMode.value,
      ...(autoLoop.value ? { brainstormModel: brainstormModel.value } : {}),
      reasoningEffortByModel: { ...reasoningEffortByModel.value, [model.value]: reasoningEffort.value },
    })

    // Subscribe to receive WebSocket events for this workspace
    wsStoreForProgress.subscribe(workspace.id)
    store.selectWorkspace(workspace.id)
    // The form has nothing left to save: the workspace exists. Drop the scope
    // BEFORE navigating — the `finally` below resets `submitting` synchronously,
    // so by the time the router guard runs (a microtask later) the predicate
    // would be true again and every successful creation would pop the
    // "unsaved work" dialog, with "Stay" trapping the user on the form of a
    // workspace that was already created. `onUnmounted` unregisters again; the
    // registry tolerates that (see unsaved-guard.test.ts).
    unregisterUnsavedScope('create:form')
    void router.push({ name: 'workspace', params: { id: workspace.id } })
  } catch (err) {
    // The server undoes what it created when a step fails — every step past
    // `create-record` — so there is nothing half-built to navigate to, only an
    // error worth reading. The message itself flags whatever the rollback
    // could not reach. The step name is the whole point: "it failed" is what
    // the page said before.
    const step = (err as { code?: string })?.code
    const message = err instanceof Error && err.message ? err.message : t('createPage.errorCreating')
    $q.notify({
      type: 'negative',
      position: 'top',
      timeout: 0,
      multiLine: true,
      message: step ? t('createPage.errorAtStep', { step, message }) : message,
      actions: [{ label: t('common.close'), color: 'white' }],
    })
  } finally {
    submitting.value = false
    wsStoreForProgress.unsubscribe(newCreationId)
    creationId.value = null
    store.clearCreationProgress()
  }
}
</script>

<style lang="scss" scoped>
.create-page {
  position: relative;
  min-height: 100%;
  padding: 48px 24px 80px;
  background: var(--kobo-bg);
}

.create-page__drawer-toggle {
  position: absolute;
  top: var(--kobo-space-md);
  left: var(--kobo-space-md);
  z-index: 1;
}

.create-page__progress {
  display: flex;
  align-items: center;
  gap: var(--kobo-space-sm);
  color: var(--kobo-text-2);
}

.create-page__progress-counter {
  font-family: var(--kobo-font-mono);
  color: var(--kobo-text-3);
}

.create-page__overrides {
  display: flex;
  flex-direction: column;
  gap: var(--kobo-space-xs);
  padding: var(--kobo-space-md);
  border: 1px solid var(--kobo-border-subtle);
  border-radius: var(--kobo-radius-sm);
  background: var(--kobo-surface-2);
}

.create-page__overrides-title {
  display: flex;
  align-items: center;
  gap: var(--kobo-space-xs);
  color: var(--kobo-text-2);
}

.create-page__overrides-item {
  color: var(--kobo-text-3);
}

.create-inner {
  width: 100%;
  max-width: 960px;
}

.create-title {
  font-size: 30px;
  line-height: 1.2;
  letter-spacing: -0.02em;
}

.create-sections {
  gap: 24px;
}

.responsive-fields {
  row-gap: 16px;

  &--sm {
    row-gap: 8px;
  }
}

.create-section-card,
.create-actions-card {
  background: var(--kobo-surface);
  border-color: rgba(255, 255, 255, 0.12);
}

.card-textarea-wrap {
  position: relative;
}

.create-textarea {
  :deep(.q-field__control) {
    min-height: 220px;
  }

  :deep(textarea) {
    min-height: 180px !important;
    line-height: 1.6;
    resize: vertical;
  }
}

.create-slash-popup {
  position: absolute;
  top: calc(100% + 4px);
  left: 12px;
  right: 12px;
  z-index: 20;
}

.source-panel {
  background: var(--kobo-surface-2);
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.peek-card {
  color: var(--kobo-text-2);
  background: rgba(255, 255, 255, 0.025);
  border-color: rgba(255, 255, 255, 0.1);
  transition:
    background 0.15s ease,
    border-color 0.15s ease,
    transform 0.1s ease;

  &:hover {
    background: rgba(255, 255, 255, 0.06);
    border-color: rgba(129, 140, 248, 0.5);
  }

  &:active {
    transform: scale(0.99);
  }

  &--active {
    background: rgba(99, 102, 241, 0.14);
    border-color: var(--kobo-accent);
    box-shadow: inset 0 0 0 1px rgba(129, 140, 248, 0.35);

    .peek-card-icon {
      color: var(--kobo-text-2);
    }
  }
}

.peek-card-icon {
  flex-shrink: 0;
  color: var(--kobo-text-3);
}

.manual-expansion,
.advanced-options {
  overflow: hidden;
  background: var(--kobo-surface-2);
  border: 1px solid rgba(255, 255, 255, 0.1);

  :deep(.q-expansion-item__content) {
    background: var(--kobo-bg-deep);
  }
}

.manual-expansion {
  :deep(.q-chip) {
    max-width: 100%;
    height: auto;
    min-height: 32px;
  }

  :deep(.q-chip__content) {
    white-space: normal;
    overflow-wrap: anywhere;
  }
}

.auto-loop-panel {
  gap: 16px;
  background: rgba(245, 158, 11, 0.06);
  border-top: 1px solid rgba(245, 158, 11, 0.22);
}

.auto-loop-session-toggle {
  :deep(.q-btn) {
    min-height: 32px;
    padding-top: 4px;
    padding-bottom: 4px;
  }
}

:deep(.agent-config-header) {
  min-height: 56px;
  padding-top: 6px;
  padding-bottom: 8px;
}

.agent-summary {
  row-gap: 4px;

  :deep(.q-chip) {
    margin: 0;
  }
}

.create-actions-card {
  position: sticky;
  bottom: 16px;
  z-index: 10;
  box-shadow: 0 10px 36px rgba(0, 0, 0, 0.38);
}

.voice-btn--recording {
  animation: voice-pulse 1.1s ease-in-out infinite;
}

@keyframes voice-pulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 1;
  }

  50% {
    transform: scale(1.06);
    opacity: 0.86;
  }
}

.slide-enter-active,
.slide-leave-active {
  overflow: hidden;
  transition:
    max-height 0.2s ease,
    opacity 0.2s ease;
}

.slide-enter-from,
.slide-leave-to {
  max-height: 0;
  opacity: 0;
}

.slide-enter-to,
.slide-leave-from {
  max-height: 900px;
  opacity: 1;
}

@media (max-width: 599px) {
  .create-page {
    padding: 28px 12px 56px;
  }

  .create-title {
    font-size: 26px;
  }

  .create-actions-card {
    bottom: 8px;

    :deep(.q-card__section) {
      align-items: stretch;
    }
  }

  .create-actions {
    width: 100%;

    .q-btn:last-child {
      flex: 1;
    }
  }
}
</style>
