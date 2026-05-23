<template>
  <q-page class="settings-page">
    <div class="settings-layout">
      <!-- Sidebar nav -->
      <aside class="settings-nav">
        <div class="settings-nav__title">{{ $t('settings.title') }}</div>
        <q-list dense class="settings-nav__list">
          <q-item
            v-for="item in navItems"
            :key="item.value"
            clickable
            v-ripple="false"
            :data-tour="`settings-nav-${item.value}`"
            :class="['settings-nav__item', { 'settings-nav__item--active': activeTab === item.value }]"
            @click="activeTab = item.value"
          >
            <q-item-section avatar class="settings-nav__icon">
              <q-icon :name="item.icon" size="16px" />
            </q-item-section>
            <q-item-section class="settings-nav__label">{{ item.label }}</q-item-section>
          </q-item>
        </q-list>
      </aside>

      <!-- Content panel -->
      <main class="settings-content">
        <header class="settings-content__header">
          <h2 class="settings-content__title">{{ activeNavLabel }}</h2>
        </header>

        <div class="settings-panels">
        <div v-show="isGlobalSection" class="settings-global-wrap">

            <!-- Localization -->
            <div
              v-show="activeTab === 'general'"
              data-tour="settings-card-general"
              class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md"
            >
              <div class="text-subtitle2 q-mb-sm">{{ $t('settings.language') }}</div>
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

            <!-- Workspace list display -->
            <div v-show="activeTab === 'general'" class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md">
              <div class="text-subtitle2 q-mb-sm">{{ $t('settings.workspaceListSection') }}</div>
              <q-toggle
                v-model="globalFlattenWorkspaceList"
                :label="$t('settings.flattenWorkspaceList')"
                dark
                dense
                color="indigo-4"
                class="text-grey-5 text-caption"
              />
              <div class="text-caption text-grey-7 q-mt-xs">{{ $t('settings.flattenWorkspaceListHint') }}</div>
            </div>

            <!-- Skill suite -->
            <div
              v-show="activeTab === 'skills'"
              data-tour="settings-card-skills"
              class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md"
            >
              <div class="text-subtitle2 q-mb-sm">{{ $t('settings.skillSuite.section') }}</div>

              <q-option-group
                v-model="globalSkillSuite"
                :options="[
                  { label: $t('settings.skillSuite.superpowers'),         value: 'superpowers' },
                  { label: $t('settings.skillSuite.gstack'),              value: 'gstack' },
                  { label: $t('settings.skillSuite.superpowersGstack'),   value: 'superpowers+gstack' },
                  { label: $t('settings.skillSuite.custom'),              value: 'custom' },
                ]"
                type="radio"
                color="indigo-4"
                dense
                dark
                inline
              />
              <div class="text-caption text-grey-6 q-mt-xs">
                {{ $t(skillSuiteHintKey) }}
              </div>

              <q-btn
                flat dense no-caps size="sm"
                color="grey-5"
                icon="restart_alt"
                :label="$t('settings.skillSuite.reloadDefaults')"
                :disable="globalSkillSuite !== 'custom'"
                class="q-mt-sm"
                @click="confirmReloadCustomPrompts"
              />
            </div>

            <div v-if="activeTab === 'skills' && globalSkillSuite === 'custom'" class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md">
              <div class="text-subtitle2 q-mb-sm">{{ $t('settings.skillSuite.customPrompts') }}</div>

              <div class="text-caption text-grey-6 q-mb-xs q-mt-sm">{{ $t('settings.skillSuite.reviewTemplate') }}</div>
              <q-input
                v-model="globalCustomReviewTemplate"
                type="textarea"
                outlined
                autogrow
                class="settings-input mono-textarea"
              />

              <div class="text-caption text-grey-6 q-mt-md q-mb-xs">{{ $t('settings.skillSuite.autoLoopReviewGate') }}</div>
              <q-input
                v-model="globalCustomAutoLoopReviewGate"
                type="textarea"
                outlined
                autogrow
                class="settings-input mono-textarea"
              />

              <div class="text-caption text-grey-6 q-mt-md q-mb-xs">{{ $t('settings.skillSuite.autoLoopGroomingIntro') }}</div>
              <q-input
                v-model="globalCustomAutoLoopGroomingIntro"
                type="textarea"
                outlined
                autogrow
                class="settings-input mono-textarea"
              />

              <div class="text-caption text-grey-6 q-mt-md q-mb-xs">{{ $t('settings.skillSuite.qaTemplate') }}</div>
              <q-input
                v-model="globalCustomQaPromptTemplate"
                type="textarea"
                outlined
                autogrow
                class="settings-input mono-textarea"
              />

              <div class="text-caption text-grey-6 q-mt-md q-mb-xs">{{ $t('settings.skillSuite.brainstormingInstruction') }}</div>
              <q-input
                v-model="globalCustomBrainstormingInstruction"
                type="textarea"
                outlined
                autogrow
                class="settings-input mono-textarea"
              />
            </div>

            <!-- Default agent configuration -->
            <div
              v-show="activeTab === 'agents'"
              data-tour="settings-card-agents"
              class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md"
            >
              <div class="text-subtitle2 q-mb-sm">{{ $t('settings.defaultModelClaude') }}</div>
              <q-select
                v-model="globalClaudeModel"
                :options="modelOptions"
                emit-value
                map-options
                option-value="value"
                option-label="label"
                dense
                dark
                outlined
                class="settings-input q-mb-md"
              />

              <div class="text-subtitle2 q-mb-sm q-mt-md">{{ $t('settings.defaultModelCodex') }}</div>
              <q-select
                v-model="globalCodexModel"
                :options="codexModelOptions"
                emit-value
                map-options
                option-value="value"
                option-label="label"
                dense
                dark
                outlined
                class="settings-input q-mb-md"
              />

              <div class="text-subtitle2 q-mb-sm q-mt-md">{{ $t('settings.defaultPermissionModeClaude') }}</div>
              <div class="text-caption text-grey-7 q-mb-sm">{{ $t('settings.defaultPermissionModeHint') }}</div>
              <q-select
                v-model="globalClaudePermissionMode"
                :options="claudePermissionModeOptions"
                emit-value
                map-options
                dense
                dark
                outlined
                class="settings-input q-mb-md"
              />

              <div class="text-subtitle2 q-mb-sm q-mt-md">{{ $t('settings.defaultPermissionModeCodex') }}</div>
              <q-select
                v-model="globalCodexPermissionMode"
                :options="codexPermissionModeOptions"
                emit-value
                map-options
                dense
                dark
                outlined
                class="settings-input"
              />
            </div>

            <!-- Activity feed display -->
            <div v-show="activeTab === 'general'" class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md">
              <div class="text-subtitle2 q-mb-sm">{{ $t('settings.activityFeed') }}</div>
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
            <div
              v-show="activeTab === 'notifications'"
              data-tour="settings-card-notifications"
              class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md"
            >
              <div class="text-subtitle2 q-mb-sm">{{ $t('settings.notifications') }}</div>
              <div class="column q-gutter-xs">
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
              <div class="row items-center q-gutter-sm q-mt-sm">
                <q-select
                  v-model="globalAudioNotificationSound"
                  :options="soundSelectOptions"
                  :label="$t('settings.notificationSound')"
                  :disable="!globalAudioNotifications"
                  dark
                  dense
                  outlined
                  emit-value
                  map-options
                  color="indigo-4"
                  class="col"
                />
                <q-btn
                  flat
                  dense
                  color="indigo-4"
                  icon="play_arrow"
                  :label="$t('settings.notificationSoundPreview')"
                  :disable="!globalAudioNotifications"
                  @click="previewNotificationSound"
                />
              </div>
              <div class="row items-center q-gutter-sm q-mt-sm">
                <div class="text-grey-5 text-caption" style="min-width: 80px;">
                  {{ $t('settings.notificationVolume') }}
                </div>
                <q-slider
                  v-model="globalAudioNotificationVolume"
                  :min="0"
                  :max="1"
                  :step="0.05"
                  :disable="!globalAudioNotifications"
                  dark
                  dense
                  color="indigo-4"
                  class="col"
                />
                <div class="text-grey-5 text-caption" style="min-width: 40px; text-align: right;">
                  {{ Math.round(globalAudioNotificationVolume * 100) }}%
                </div>
              </div>
            </div>

            <!-- Voice transcription — Runtime status -->
            <div
              v-show="activeTab === 'voice'"
              data-tour="settings-card-voice"
              class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md"
            >
              <div class="row items-center q-mb-sm">
                <div class="text-subtitle2">{{ $t('voice.sectionRuntime') }}</div>
                <q-space />
                <q-btn
                  flat
                  dense
                  no-caps
                  size="sm"
                  icon="refresh"
                  color="grey-5"
                  :label="t('common.refresh')"
                  @click="store.fetchVoiceRuntime()"
                />
              </div>
              <div class="column q-gutter-xs">
                <div class="row items-center q-gutter-sm">
                  <q-icon
                    :name="store.voiceRuntime?.available ? 'check_circle' : 'cancel'"
                    :color="store.voiceRuntime?.available ? 'green-5' : 'red-5'"
                    size="xs"
                  />
                  <span
                    class="text-caption"
                    :class="store.voiceRuntime?.available ? 'text-green-5' : 'text-red-5'"
                  >
                    {{
                      store.voiceRuntime?.available
                        ? t('voice.runtimeReady', { command: store.voiceRuntime?.command ?? 'whisper-cli' })
                        : t('voice.runtimeMissing', { command: store.voiceRuntime?.command ?? 'whisper-cli' })
                    }}
                  </span>
                </div>
                <div class="row items-center q-gutter-sm">
                  <q-icon
                    :name="store.voiceRuntime?.ffmpegAvailable ? 'check_circle' : 'cancel'"
                    :color="store.voiceRuntime?.ffmpegAvailable ? 'green-5' : 'red-5'"
                    size="xs"
                  />
                  <span
                    class="text-caption"
                    :class="store.voiceRuntime?.ffmpegAvailable ? 'text-green-5' : 'text-red-5'"
                  >
                    {{
                      store.voiceRuntime?.ffmpegAvailable
                        ? t('voice.ffmpegReady')
                        : t('voice.ffmpegMissing')
                    }}
                  </span>
                </div>
              </div>
              <q-expansion-item
                dense
                dark
                icon="help_outline"
                :label="$t('voice.installGuideTitle')"
                class="variables-panel rounded-borders q-mt-sm"
              >
                <div class="q-pa-sm text-caption text-grey-5">
                  <div class="q-mb-sm">{{ $t('voice.installGuideIntro') }}</div>
                  <div class="q-mb-sm">
                    <a
                      href="https://github.com/ggml-org/whisper.cpp"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="text-indigo-4"
                    >
                      {{ $t('voice.installLink') }}
                    </a>
                  </div>
                  <div class="q-mb-xs text-grey-4">{{ $t('voice.installGuideUbuntuTitle') }}</div>
                  <pre class="mono-guide q-mb-sm">sudo apt update
sudo apt install -y cmake build-essential ffmpeg
git clone https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp
cmake -B build
cmake --build build -j</pre>
                  <div class="q-mb-sm">{{ $t('voice.installGuideBinaryPathHint') }}</div>
                  <div class="q-mb-xs text-grey-4">{{ $t('voice.installGuideWindowsTitle') }}</div>
                  <pre class="mono-guide q-mb-sm"># Install CMake + Visual Studio Build Tools (C/C++)
# Install ffmpeg (choco/scoop)
where whisper-cli
where ffmpeg</pre>
                  <div>{{ $t('voice.installGuideSettingsHint') }}</div>
                </div>
              </q-expansion-item>
            </div>

            <!-- Voice transcription — Activation -->
            <div v-show="activeTab === 'voice'" class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md">
              <div class="text-subtitle2 q-mb-sm">{{ $t('voice.sectionActivation') }}</div>
              <q-toggle
                v-model="globalVoiceEnabled"
                :label="$t('voice.enabled')"
                dark
                dense
                color="indigo-4"
                class="text-grey-5 text-caption q-mb-sm"
              />
              <div class="row q-col-gutter-sm">
                <div class="col-12 col-sm-6">
                  <q-select
                    v-model="globalVoicePttKey"
                    :label="$t('voice.pttKey')"
                    :options="[
                      { label: $t('voice.pttAlt'), value: 'alt' },
                      { label: $t('voice.pttCtrlSpace'), value: 'ctrl+space' },
                    ]"
                    emit-value
                    map-options
                    dense
                    dark
                    outlined
                    class="settings-input"
                  />
                </div>
                <div class="col-12 col-sm-6">
                  <q-select
                    v-model="globalVoiceLanguage"
                    :label="$t('voice.language')"
                    :options="voiceLanguageOptions"
                    emit-value
                    map-options
                    dense
                    dark
                    outlined
                    class="settings-input"
                  />
                </div>
              </div>
            </div>

            <!-- Voice transcription — Models -->
            <div v-show="activeTab === 'voice'" class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md">
              <div class="text-subtitle2 q-mb-sm">{{ $t('voice.sectionModels') }}</div>
              <q-select
                v-model="globalVoiceModel"
                :label="$t('voice.model')"
                :options="voiceModelOptions"
                emit-value
                map-options
                dense
                dark
                outlined
                class="settings-input q-mb-md"
              />
              <div v-if="store.voiceModelsDir" class="voice-models-dir row items-center q-gutter-sm q-mb-md">
                <q-icon name="folder" color="grey-5" size="xs" />
                <span class="text-caption text-grey-5 ellipsis-2-lines" style="flex: 1; min-width: 0; word-break: break-all;">
                  {{ store.voiceModelsDir }}
                </span>
                <q-btn
                  flat
                  dense
                  round
                  size="xs"
                  icon="content_copy"
                  color="grey-5"
                  :title="t('common.copy')"
                  @click="copyToClipboard(store.voiceModelsDir)"
                />
              </div>
              <div class="column q-gutter-sm">
                <div
                  v-for="m in store.voiceModels"
                  :key="m.name"
                  class="voice-model-row q-pa-sm rounded-borders"
                  :class="{ 'voice-model-row--active': m.download }"
                >
                  <div class="row items-center q-gutter-sm">
                    <q-icon
                      :name="m.download ? 'downloading' : m.installed ? 'check_circle' : 'circle'"
                      :color="m.download ? 'indigo-4' : m.installed ? 'green-5' : 'grey-7'"
                      size="xs"
                    />
                    <span class="text-body2 text-grey-3" style="font-family: var(--kobo-font-mono, monospace);">
                      {{ m.name }}
                    </span>
                    <span class="text-caption text-grey-6">
                      {{ formatBytes(m.installedSizeBytes ?? m.sizeBytes) }}
                    </span>
                    <q-space />
                    <q-btn
                      v-if="m.download"
                      flat
                      dense
                      no-caps
                      size="sm"
                      color="grey-5"
                      icon="close"
                      :label="$t('common.cancel')"
                      @click="cancelVoiceDownload(m.name)"
                    />
                    <q-btn
                      v-else
                      flat
                      dense
                      no-caps
                      size="sm"
                      :color="m.installed ? 'red-5' : 'indigo-4'"
                      :icon="m.installed ? 'delete_outline' : 'download'"
                      :label="m.installed ? $t('voice.delete') : $t('voice.download')"
                      :loading="voiceActionModel === m.name"
                      @click="m.installed ? removeVoiceModel(m.name) : installVoiceModel(m.name)"
                    />
                  </div>
                  <div v-if="m.download" class="q-mt-sm">
                    <q-linear-progress
                      :value="m.download.total > 0 ? Math.min(1, m.download.downloaded / m.download.total) : 0"
                      :indeterminate="!m.download.total"
                      color="indigo-4"
                      track-color="grey-9"
                      size="6px"
                      rounded
                    />
                    <div class="row items-center q-mt-xs">
                      <span class="text-caption text-grey-6">
                        {{ formatBytes(m.download.downloaded) }} / {{ formatBytes(m.download.total) }}
                      </span>
                      <q-space />
                      <span class="text-caption text-indigo-4">
                        {{
                          m.download.total > 0
                            ? `${Math.floor((m.download.downloaded / m.download.total) * 100)}%`
                            : '—'
                        }}
                      </span>
                    </div>
                  </div>
                  <div
                    v-else-if="m.installed"
                    class="text-caption text-grey-7 q-mt-xs ellipsis"
                    style="font-family: var(--kobo-font-mono, monospace); word-break: break-all;"
                  >
                    {{ m.fileName }}
                  </div>
                </div>
              </div>
            </div>

            <!-- Voice transcription — Advanced options -->
            <div v-show="activeTab === 'voice'" class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md">
              <div class="text-subtitle2 q-mb-sm">{{ $t('voice.sectionAdvanced') }}</div>
              <q-expansion-item
                dense
                dark
                icon="tune"
                :label="$t('voice.sectionBehavior')"
                class="variables-panel rounded-borders q-mb-sm"
              >
                <div class="q-pa-sm column q-gutter-sm">
                  <div class="row items-center q-gutter-sm">
                    <div class="text-caption text-grey-5">{{ $t('voice.temperature') }}</div>
                    <q-slider
                      v-model="globalVoiceTemperature"
                      :min="0"
                      :max="1"
                      :step="0.05"
                      dark
                      dense
                      color="indigo-4"
                      class="col"
                    />
                    <div class="text-caption text-grey-5" style="min-width: 40px; text-align: right;">
                      {{ globalVoiceTemperature.toFixed(2) }}
                    </div>
                  </div>
                  <div class="text-caption text-grey-7">{{ $t('voice.temperatureHint') }}</div>
                  <q-input
                    v-model="globalVoicePrompt"
                    :label="$t('voice.initialPrompt')"
                    type="textarea"
                    dense
                    dark
                    outlined
                    :rows="2"
                    class="settings-input"
                  />
                  <div class="text-caption text-grey-7">{{ $t('voice.initialPromptHint') }}</div>
                  <q-toggle
                    v-model="globalVoiceTranslateToEnglish"
                    :label="$t('voice.translateToEnglish')"
                    dark
                    dense
                    color="indigo-4"
                    class="text-grey-5 text-caption"
                  />
                  <div class="text-caption text-grey-7">{{ $t('voice.translateToEnglishHint') }}</div>
                  <q-toggle
                    v-model="globalVoiceSuppressNst"
                    :label="$t('voice.suppressNst')"
                    dark
                    dense
                    color="indigo-4"
                    class="text-grey-5 text-caption"
                  />
                  <div class="text-caption text-grey-7">{{ $t('voice.suppressNstHint') }}</div>
                </div>
              </q-expansion-item>
              <q-expansion-item
                dense
                dark
                icon="terminal"
                :label="$t('voice.sectionBinaries')"
                class="variables-panel rounded-borders"
              >
                <div class="q-pa-sm column q-gutter-sm">
                  <q-input
                    v-model="globalVoiceCommandPath"
                    :label="$t('voice.commandPath')"
                    dense
                    dark
                    outlined
                    class="settings-input"
                  />
                  <q-input
                    v-model="globalVoiceFfmpegPath"
                    :label="$t('voice.ffmpegPath')"
                    dense
                    dark
                    outlined
                    class="settings-input"
                  />
                </div>
              </q-expansion-item>
            </div>

            <div
              v-if="activeTab === 'prompts'"
              data-tour="settings-card-prompts"
              class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md"
            >
              <div class="row items-center q-mb-sm">
                <div class="text-subtitle2">{{ $t('settings.prPromptTemplate') }}</div>
                <q-space />
                <q-btn
                  flat
                  dense
                  no-caps
                  size="sm"
                  color="grey-5"
                  icon="restart_alt"
                  :label="t('settings.resetToDefault')"
                  :loading="resettingField === 'prPromptTemplate'"
                  :disable="resettingField !== null && resettingField !== 'prPromptTemplate'"
                  @click="resetFieldToDefault('prPromptTemplate')"
                />
              </div>
              <div class="text-caption text-grey-7 q-mb-sm">{{ $t('settings.prPromptHint') }}</div>
              <q-input
                v-model="globalPrPrompt"
                type="textarea"
                dense
                dark
                outlined
                :rows="8"
                :placeholder="$t('settings.prPromptPlaceholder')"
                class="settings-input mono-textarea q-mb-md"
              />

              <div class="q-mb-sm">
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

              <div class="row items-center q-mb-sm q-mt-md">
                <div class="text-subtitle2">{{ $t('settings.reviewPromptTemplate') }}</div>
                <q-space />
                <q-btn
                  flat
                  dense
                  no-caps
                  size="sm"
                  color="grey-5"
                  icon="restart_alt"
                  :label="t('settings.resetToDefault')"
                  :loading="resettingField === 'reviewPromptTemplate'"
                  :disable="resettingField !== null && resettingField !== 'reviewPromptTemplate'"
                  @click="resetFieldToDefault('reviewPromptTemplate')"
                />
              </div>
              <div class="text-caption text-grey-7 q-mb-sm">{{ $t('settings.prPromptHint') }}</div>
              <q-input
                v-model="globalReviewPrompt"
                type="textarea"
                dense
                dark
                outlined
                :rows="8"
                :placeholder="$t('settings.reviewPromptPlaceholder')"
                class="settings-input mono-textarea q-mb-md"
              />

              <div class="row items-center q-mb-sm q-mt-md">
                <div class="text-subtitle2">{{ $t('settings.ciFixPromptTemplate') }}</div>
                <q-space />
                <q-btn
                  flat
                  dense
                  no-caps
                  size="sm"
                  color="grey-5"
                  icon="restart_alt"
                  :label="t('settings.resetToDefault')"
                  :loading="resettingField === 'ciFixPromptTemplate'"
                  :disable="resettingField !== null && resettingField !== 'ciFixPromptTemplate'"
                  @click="resetFieldToDefault('ciFixPromptTemplate')"
                />
              </div>
              <div class="text-caption text-grey-7 q-mb-sm">{{ $t('settings.ciFixPromptHint') }}</div>
              <q-input
                v-model="globalCiFixPrompt"
                type="textarea"
                dense
                dark
                outlined
                :rows="8"
                :placeholder="$t('settings.ciFixPromptPlaceholder')"
                class="settings-input mono-textarea q-mb-md"
              />

              <div class="row items-center q-mb-sm q-mt-md">
                <div class="text-subtitle2">{{ $t('settings.gitConventions') }}</div>
                <q-space />
                <q-btn
                  flat
                  dense
                  no-caps
                  size="sm"
                  color="grey-5"
                  icon="restart_alt"
                  :label="t('settings.resetToDefault')"
                  :loading="resettingField === 'gitConventions'"
                  :disable="resettingField !== null && resettingField !== 'gitConventions'"
                  @click="resetFieldToDefault('gitConventions')"
                />
              </div>
              <div class="text-caption text-grey-7 q-mb-sm">{{ $t('settings.gitConventionsHint') }}</div>
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
            </div>

            <!-- Editor -->
            <div v-show="activeTab === 'general'" class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md">
              <div class="text-subtitle2 q-mb-sm">{{ $t('settings.editorCommand') }}</div>
              <div class="text-caption text-grey-7 q-mb-sm">{{ $t('settings.editorCommandHint') }}</div>
              <q-input
                v-model="globalEditorCommand"
                dense
                dark
                outlined
                :placeholder="$t('settings.editorCommandPlaceholder')"
                class="settings-input"
              />
            </div>

            <div
              v-show="activeTab === 'notion' || activeTab === 'sentry'"
              data-tour="settings-card-notion"
              class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md"
            >
              <div class="text-subtitle2 q-mb-sm">{{ $t('settings.mcpSelection') }}</div>
              <div class="text-caption text-grey-7 q-mb-sm">{{ $t('settings.mcpSelectionHint') }}</div>
              <div class="q-mb-sm">
                <div class="field-label-sub text-caption q-mb-xs text-grey-7">{{ $t('settings.notionMcp') }}</div>
                <q-select
                  v-model="globalNotionMcpKey"
                  :options="mcpServerOptions"
                  emit-value
                  map-options
                  dense
                  dark
                  outlined
                  class="settings-input"
                />
              </div>
              <div class="q-mb-sm">
                <div class="field-label-sub text-caption q-mb-xs text-grey-7">{{ $t('settings.sentryMcp') }}</div>
                <q-select
                  v-model="globalSentryMcpKey"
                  :options="mcpServerOptions"
                  emit-value
                  map-options
                  dense
                  dark
                  outlined
                  class="settings-input"
                />
              </div>
            </div>

            <div v-if="activeTab === 'notion'" class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md">
              <div class="text-subtitle2 q-mb-sm">{{ $t('settings.notionStatus') }}</div>
              <div class="text-caption text-grey-7 q-mb-sm">{{ $t('settings.notionStatusHint') }}</div>
              <div class="q-mb-sm">
                <div class="field-label-sub text-caption q-mb-xs text-grey-7">{{ $t('settings.notionStatusProperty') }}</div>
                <q-input
                  v-model="globalNotionStatusProperty"
                  dense
                  dark
                  outlined
                  :placeholder="$t('settings.notionStatusPropertyPlaceholder')"
                  class="settings-input"
                />
              </div>
              <div class="q-mb-sm">
                <div class="field-label-sub text-caption q-mb-xs text-grey-7">{{ $t('settings.notionInProgressStatus') }}</div>
                <q-input
                  v-model="globalNotionStatus"
                  dense
                  dark
                  outlined
                  :placeholder="$t('settings.notionInProgressStatusPlaceholder')"
                  class="settings-input"
                />
              </div>
              <div class="row items-center q-mb-sm">
                <div class="text-subtitle2">{{ t('settings.notionInitialPrompt') }}</div>
                <q-space />
                <q-btn
                  flat
                  dense
                  no-caps
                  size="sm"
                  color="grey-5"
                  icon="restart_alt"
                  :label="t('settings.resetToDefault')"
                  :loading="resettingField === 'notionInitialPromptTemplate'"
                  :disable="resettingField !== null && resettingField !== 'notionInitialPromptTemplate'"
                  @click="resetFieldToDefault('notionInitialPromptTemplate')"
                />
              </div>
              <div class="text-caption text-grey-7 q-mb-xs">{{ t('settings.notionInitialPrompt.help', { variables: '{ticket_id}, {notion_url}, {notion_file_path}' }) }}</div>
              <q-input
                v-model="globalNotionInitialPrompt"
                type="textarea"
                outlined
                autogrow
                class="settings-input mono-textarea"
              />
            </div>

            <!-- Notion assignment -->
            <div v-show="activeTab === 'notion'" class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md">
              <div class="text-subtitle2 q-mb-sm">{{ $t('settings.notionAssignee') }}</div>
              <div class="text-caption text-grey-7 q-mb-sm">{{ $t('settings.notionAssigneeHint') }}</div>
              <div class="q-mb-sm">
                <div class="field-label-sub text-caption q-mb-xs text-grey-7">{{ $t('settings.notionAssigneeProperty') }}</div>
                <q-input
                  v-model="globalNotionAssigneeProperty"
                  dense
                  dark
                  outlined
                  :placeholder="$t('settings.notionAssigneePropertyPlaceholder')"
                  class="settings-input"
                />
              </div>
              <div class="q-mb-sm">
                <div class="row items-center q-mb-xs">
                  <div class="field-label-sub text-caption text-grey-7 col">{{ $t('settings.notionUserId') }}</div>
                  <q-btn
                    flat
                    dense
                    no-caps
                    size="sm"
                    icon="refresh"
                    color="grey-5"
                    :loading="loadingNotionUsers"
                    :label="$t('settings.notionUsersRefresh')"
                    @click="loadNotionUsers(true)"
                  />
                </div>
                <q-select
                  v-if="notionUsers.length > 0"
                  v-model="globalNotionUserId"
                  :options="notionUserOptions"
                  emit-value
                  map-options
                  clearable
                  dense
                  dark
                  outlined
                  :hint="$t('settings.notionUserIdHint')"
                  class="settings-input"
                >
                  <template #option="scope">
                    <q-item v-bind="scope.itemProps">
                      <q-item-section avatar>
                        <q-avatar size="24px">
                          <img v-if="scope.opt.avatarUrl" :src="scope.opt.avatarUrl" :alt="scope.opt.label">
                          <q-icon v-else name="person" size="20px" />
                        </q-avatar>
                      </q-item-section>
                      <q-item-section>
                        <q-item-label>{{ scope.opt.name }}</q-item-label>
                        <q-item-label caption>{{ scope.opt.email }}</q-item-label>
                      </q-item-section>
                    </q-item>
                  </template>
                </q-select>
                <div v-else-if="loadingNotionUsers" class="text-caption text-grey-7 q-py-sm">
                  {{ $t('settings.notionUsersLoading') }}
                </div>
                <template v-else>
                  <div v-if="notionUsersError" class="text-caption text-orange-5 q-mb-xs">
                    {{ $t('settings.notionUsersLoadFailed', { error: notionUsersError }) }}
                  </div>
                  <q-input
                    v-model="globalNotionUserId"
                    dense
                    dark
                    outlined
                    :placeholder="$t('settings.notionUserIdPlaceholder')"
                    :hint="notionUsersError ? $t('settings.notionUsersManualFallback') : $t('settings.notionUserIdHint')"
                    class="settings-input"
                  />
                </template>
              </div>
            </div>

            <div v-if="activeTab === 'sentry'" class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md">
              <div class="text-subtitle2 q-mb-sm">{{ t('settings.sentryIntegration') }}</div>
              <div class="row items-center q-mb-sm">
                <div class="text-subtitle2">{{ t('settings.sentryInitialPrompt') }}</div>
                <q-space />
                <q-btn
                  flat
                  dense
                  no-caps
                  size="sm"
                  color="grey-5"
                  icon="restart_alt"
                  :label="t('settings.resetToDefault')"
                  :loading="resettingField === 'sentryInitialPromptTemplate'"
                  :disable="resettingField !== null && resettingField !== 'sentryInitialPromptTemplate'"
                  @click="resetFieldToDefault('sentryInitialPromptTemplate')"
                />
              </div>
              <div class="text-caption text-grey-7 q-mb-xs">{{ t('settings.sentryInitialPrompt.help', { variables: '{issue_id}, {sentry_url}, {sentry_file_path}' }) }}</div>
              <q-input
                v-model="globalSentryInitialPrompt"
                type="textarea"
                outlined
                autogrow
                class="settings-input mono-textarea"
              />
            </div>

            <!-- Workspace tags -->
            <div v-show="activeTab === 'general'" class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md">
              <div class="text-subtitle2 q-mb-sm">{{ $t('settings.tagsTitle') }}</div>
              <div class="text-caption text-grey-7 q-mb-sm">{{ $t('settings.tagsHint') }}</div>
              <q-select
                v-model="globalTags"
                :label="$t('settings.tagsLabel')"
                dark
                outlined
                multiple
                use-input
                use-chips
                new-value-mode="add-unique"
                hide-dropdown-icon
                input-debounce="0"
                class="settings-input"
              />
            </div>

            <!-- Branch prefixes -->
            <div v-show="activeTab === 'general'" class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md">
              <div class="text-subtitle2 q-mb-sm">{{ $t('settings.branchPrefixesTitle') }}</div>
              <div class="text-caption text-grey-7 q-mb-sm">{{ $t('settings.branchPrefixesHint') }}</div>

              <q-list
                v-if="globalBranchPrefixes.length > 0"
                bordered
                separator
                class="rounded-borders q-mb-sm"
              >
                <q-item v-for="(prefix, index) in globalBranchPrefixes" :key="prefix">
                  <q-item-section>
                    <q-item-label class="cursor-pointer">
                      {{ prefix }}/
                      <q-popup-edit
                        :model-value="prefix"
                        auto-save
                        @save="(val: string) => updateBranchPrefix(index, val)"
                      >
                        <template #default="scope">
                          <q-input
                            v-model="scope.value"
                            dense
                            dark
                            autofocus
                            @keyup.enter="scope.set"
                          />
                        </template>
                      </q-popup-edit>
                      <q-tooltip>{{ $t('settings.branchPrefixesEditHint') }}</q-tooltip>
                    </q-item-label>
                  </q-item-section>
                  <q-item-section side>
                    <div class="row items-center no-wrap">
                      <q-btn
                        flat
                        dense
                        round
                        size="sm"
                        icon="keyboard_arrow_up"
                        color="grey-6"
                        :disable="index === 0"
                        :title="$t('settings.branchPrefixesMoveUp')"
                        @click="moveBranchPrefix(index, -1)"
                      />
                      <q-btn
                        flat
                        dense
                        round
                        size="sm"
                        icon="keyboard_arrow_down"
                        color="grey-6"
                        :disable="index === globalBranchPrefixes.length - 1"
                        :title="$t('settings.branchPrefixesMoveDown')"
                        @click="moveBranchPrefix(index, 1)"
                      />
                      <q-btn
                        flat
                        dense
                        round
                        size="sm"
                        icon="delete"
                        color="grey-6"
                        :title="$t('common.delete')"
                        @click="removeBranchPrefix(index)"
                      />
                    </div>
                  </q-item-section>
                </q-item>
              </q-list>
              <div v-else class="text-caption text-grey-7 q-mb-sm">
                {{ $t('settings.branchPrefixesEmpty') }}
              </div>

              <div class="row items-center q-gutter-sm">
                <q-input
                  v-model="newBranchPrefix"
                  :label="$t('settings.branchPrefixesAddLabel')"
                  dense
                  dark
                  outlined
                  class="col"
                  @keyup.enter="addBranchPrefix"
                />
                <q-btn
                  flat
                  :label="$t('common.add')"
                  icon="add"
                  color="primary"
                  :disable="normalizeBranchPrefix(newBranchPrefix).length === 0"
                  @click="addBranchPrefix"
                />
              </div>
            </div>

            <!-- Setup script -->
            <div
              v-show="activeTab === 'scripts'"
              data-tour="settings-card-scripts"
              class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md"
            >
              <div class="text-subtitle2 q-mb-sm">{{ $t('settings.setupScript') }}</div>
              <div class="text-caption text-grey-7 q-mb-sm">{{ $t('settings.setupScriptHint') }}</div>
              <q-input
                v-model="globalSetupScript"
                type="textarea"
                dark
                outlined
                autogrow
                :input-style="{ minHeight: '100px' }"
                :placeholder="$t('settings.setupScriptPlaceholder')"
                class="settings-input mono-textarea"
              />
            </div>

            <!-- Onboarding tour -->
            <div v-show="activeTab === 'general'" class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md">
              <div class="text-subtitle2 q-mb-sm">{{ $t('settings.onboardingTitle') }}</div>
              <div class="text-caption text-grey-7 q-mb-sm">{{ $t('settings.onboardingHint') }}</div>
              <q-btn
                flat
                no-caps
                icon="play_circle"
                color="indigo-4"
                :label="$t('settings.onboardingReplay')"
                @click="startTour"
              />
            </div>

            <!-- Cleanup script -->
            <div v-show="activeTab === 'scripts'" class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md">
              <div class="text-subtitle2 q-mb-sm">{{ $t('settings.cleanupScript') }}</div>
              <div class="text-caption text-grey-7 q-mb-sm">{{ $t('settings.cleanupScriptHint') }}</div>
              <q-input
                v-model="globalCleanupScript"
                type="textarea"
                dark
                outlined
                autogrow
                :input-style="{ minHeight: '100px' }"
                :placeholder="$t('settings.cleanupScriptPlaceholder')"
                class="settings-input mono-textarea"
              />
              <div class="text-caption text-grey-6 q-mt-md q-mb-xs">{{ $t('settings.cleanupScriptMode') }}</div>
              <q-option-group
                v-model="globalCleanupScriptMode"
                :options="[
                  { label: $t('settings.cleanupScriptMode.idle'), value: 'idle' },
                  { label: $t('settings.cleanupScriptMode.noTasks'), value: 'no-tasks' },
                ]"
                type="radio"
                color="indigo-4"
                dense
              />
              <q-checkbox
                v-model="globalCleanupScriptOnlyOnChanges"
                :label="$t('settings.cleanupScriptOnlyOnChanges')"
                dark
                dense
                color="indigo-4"
                class="q-mt-sm"
              />
            </div>

            <!-- Archive script -->
            <div v-show="activeTab === 'scripts'" class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md">
              <div class="text-subtitle2 q-mb-sm">{{ $t('settings.archiveScript') }}</div>
              <div class="text-caption text-grey-7 q-mb-sm">{{ $t('settings.archiveScriptHint') }}</div>
              <q-input
                v-model="globalArchiveScript"
                type="textarea"
                dark
                outlined
                autogrow
                :input-style="{ minHeight: '100px' }"
                :placeholder="$t('settings.archiveScriptPlaceholder')"
                class="settings-input mono-textarea"
              />
            </div>

            <!-- Change-source-branch script -->
            <div v-show="activeTab === 'scripts'" class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md">
              <div class="row items-center justify-between q-mb-sm">
                <div class="text-subtitle2">{{ $t('settings.changeSourceBranchScript') }}</div>
                <q-btn
                  flat
                  dense
                  no-caps
                  size="sm"
                  color="primary"
                  icon="restart_alt"
                  :label="$t('settings.changeSourceBranchScript.resetDefault')"
                  @click="insertDefaultChangeSourceBranchScript('global')"
                />
              </div>
              <div class="text-caption text-grey-7 q-mb-xs">{{ $t('settings.changeSourceBranchScript.help') }}</div>
              <pre class="text-caption text-grey-6 mono-guide q-mb-sm">{{ $t('settings.changeSourceBranchScript.envHelp') }}</pre>
              <q-input
                v-model="globalChangeSourceBranchScript"
                type="textarea"
                dark
                outlined
                :input-style="{ minHeight: '400px', maxHeight: '600px' }"
                :placeholder="$t('settings.changeSourceBranchScript.placeholder')"
                class="settings-input mono-textarea"
              />
            </div>

            <div
              v-show="activeTab === 'worktrees'"
              data-tour="settings-card-worktrees"
              class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md"
            >
              <div class="text-subtitle2 q-mb-sm">{{ $t('settings.worktreesTitle') }}</div>
              <div class="text-caption text-grey-7 q-mb-sm">{{ $t('settings.worktreesHint') }}</div>
              <q-input
                ref="globalWorktreesPathInput"
                v-model="globalWorktreesPath"
                :label="$t('settings.worktreesPathLabel')"
                dense
                dark
                outlined
                :placeholder="WORKTREES_PATH"
                :rules="worktreesPathRules"
                lazy-rules
                class="settings-input"
              />
              <q-toggle
                v-model="globalWorktreesPrefixByProject"
                :label="$t('settings.worktreesPrefixByProject')"
                dark
                dense
                color="indigo-4"
                class="text-grey-5 text-caption q-mt-sm"
              />
              <div class="text-caption text-grey-7 q-mt-xs">{{ $t('settings.worktreesPrefixByProjectHint') }}</div>
            </div>

            <!-- Import / Export config -->
            <div
              v-show="activeTab === 'export'"
              data-tour="settings-card-export"
              class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md"
            >
              <div class="text-subtitle2 q-mb-sm">{{ $t('settings.shareTitle') }}</div>
              <div class="text-caption text-grey-7 q-mb-sm">{{ $t('settings.shareHint') }}</div>
              <div class="row q-gutter-sm">
                <q-btn
                  :label="$t('settings.exportConfig')"
                  icon="download"
                  no-caps
                  outline
                  color="grey-4"
                  @click="exportConfig"
                />
                <q-btn
                  :label="$t('settings.importConfig')"
                  icon="upload"
                  no-caps
                  outline
                  color="grey-4"
                  @click="triggerImport"
                />
                <input
                  ref="importFileInput"
                  type="file"
                  accept="application/json,.json"
                  style="display: none;"
                  @change="onImportFile"
                />
              </div>
            </div>

            <!-- Save button -->
            <div class="row justify-end settings-sticky-actions">
              <q-btn
                :label="$t('common.save')"
                no-caps
                unelevated
                size="sm"
                color="primary"
                :loading="savingGlobal"
                :class="{ 'save-btn--dirty': isGlobalDirty }"
                @click="saveGlobal"
              />
            </div>
          </div>

        <!-- Projects panel -->
        <div v-show="activeTab === 'projects'" class="q-pa-none">
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
                    data-tour="settings-card-projects"
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
                  <div class="row items-center q-mb-md">
                    <div class="text-subtitle1 text-weight-medium text-grey-3">
                      {{ isNewProject ? $t('settings.newProject') : $t('settings.editProject') }}
                    </div>
                    <q-space />
                    <q-btn
                      v-if="!isNewProject"
                      :label="$t('common.delete')"
                      icon="delete_outline"
                      no-caps
                      flat
                      dense
                      size="sm"
                      color="red-5"
                      :loading="deletingProject"
                      @click="deleteProject"
                    />
                  </div>

                  <q-separator dark class="q-mb-md" />

                  <!-- Copy settings from existing project (new-project mode only) -->
                  <div v-if="isNewProject && store.projects.length > 0" class="q-mb-md">
                    <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">
                      {{ $t('settings.copyFrom') }}
                    </div>
                    <q-select
                      :model-value="copyFromPath"
                      :options="copyFromOptions"
                      option-value="value"
                      option-label="label"
                      emit-value
                      map-options
                      clearable
                      dense
                      dark
                      outlined
                      :placeholder="$t('settings.copyFromPlaceholder')"
                      class="settings-input"
                      @update:model-value="onCopyFromChange"
                    />
                    <div class="text-caption text-grey-7 q-mt-xs">
                      {{ $t('settings.copyFromHint') }}
                    </div>
                  </div>

                  <!-- Identity -->
                  <div class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md">
                    <div class="text-subtitle2 q-mb-md">{{ $t('settings.projectGroup.identity') }}</div>

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
                      >
                        <template v-if="isNewProject" #append>
                          <q-btn
                            flat
                            dense
                            round
                            size="sm"
                            icon="folder_open"
                            color="grey-5"
                            @click="folderPickerOpen = true"
                          >
                            <q-tooltip>{{ $t('folderPicker.title') }}</q-tooltip>
                          </q-btn>
                        </template>
                      </q-input>
                    </div>

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

                    <div>
                      <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">
                        {{ $t('settings.projectColor') }}
                      </div>
                      <div class="row items-center q-gutter-xs">
                        <q-chip
                          v-for="c in PROJECT_COLOR_PALETTE"
                          :key="c"
                          dense
                          clickable
                          :color="c"
                          :icon="projectForm.color === c ? 'check' : undefined"
                          text-color="white"
                          @click="projectForm.color = c"
                        />
                        <q-btn
                          flat
                          dense
                          no-caps
                          size="xs"
                          :label="$t('settings.projectColorClear')"
                          color="grey-5"
                          :disable="!projectForm.color"
                          @click="projectForm.color = null"
                        />
                      </div>
                      <div class="text-caption text-grey-6 q-mt-xs">
                        {{ projectForm.color ?? $t('settings.projectColorDefault') }}
                      </div>
                    </div>
                  </div>

                  <!-- Defaults -->
                  <div class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md">
                    <div class="text-subtitle2 q-mb-md">{{ $t('settings.projectGroup.defaults') }}</div>

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

                    <div>
                      <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">{{ $t('settings.forge') }}</div>
                      <q-select
                        v-model="projectForm.forge"
                        :options="forgeOptions"
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
                  </div>

                  <!-- Prompts -->
                  <div class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md">
                    <div class="text-subtitle2 q-mb-md">{{ $t('settings.projectGroup.prompts') }}</div>

                    <div class="q-mb-md">
                      <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">{{ $t('settings.prPromptTemplate.project') }}</div>
                      <div class="text-caption text-grey-7 q-mb-xs">{{ t('settings.initialPrompt.inheritHint') }}</div>
                      <q-input
                        v-model="projectForm.prPromptTemplate"
                        type="textarea"
                        outlined
                        autogrow
                        :input-style="{ minHeight: '100px' }"
                        :placeholder="$t('settings.prPromptPlaceholder.project')"
                        class="settings-input mono-textarea"
                      />
                    </div>

                    <div class="q-mb-md">
                      <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">{{ $t('settings.reviewPromptTemplate.project') }}</div>
                      <div class="text-caption text-grey-7 q-mb-xs">{{ t('settings.initialPrompt.inheritHint') }}</div>
                      <q-input
                        v-model="projectForm.reviewPromptTemplate"
                        type="textarea"
                        outlined
                        autogrow
                        :input-style="{ minHeight: '100px' }"
                        :placeholder="$t('settings.reviewPromptPlaceholder')"
                        class="settings-input mono-textarea"
                      />
                    </div>

                    <div class="q-mb-md">
                      <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">{{ $t('settings.ciFixPromptTemplate.project') }}</div>
                      <div class="text-caption text-grey-7 q-mb-xs">{{ t('settings.initialPrompt.inheritHint') }}</div>
                      <q-input
                        v-model="projectForm.ciFixPromptTemplate"
                        type="textarea"
                        outlined
                        autogrow
                        :input-style="{ minHeight: '100px' }"
                        :placeholder="$t('settings.ciFixPromptPlaceholder')"
                        class="settings-input mono-textarea"
                      />
                    </div>

                    <div class="q-mb-md">
                      <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">{{ t('settings.notionInitialPrompt.project') }}</div>
                      <div class="text-caption text-grey-7 q-mb-xs">{{ t('settings.initialPrompt.inheritHint') }}</div>
                      <q-input
                        v-model="projectForm.notionInitialPromptTemplate"
                        type="textarea"
                        outlined
                        autogrow
                        class="settings-input mono-textarea"
                      />
                    </div>

                    <div class="q-mb-md">
                      <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">{{ t('settings.sentryInitialPrompt.project') }}</div>
                      <div class="text-caption text-grey-7 q-mb-xs">{{ t('settings.initialPrompt.inheritHint') }}</div>
                      <q-input
                        v-model="projectForm.sentryInitialPromptTemplate"
                        type="textarea"
                        outlined
                        autogrow
                        class="settings-input mono-textarea"
                      />
                    </div>

                    <div class="q-mb-md">
                      <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">{{ $t('settings.gitConventions.project') }}</div>
                      <div class="text-caption text-grey-7 q-mb-xs">{{ t('settings.initialPrompt.inheritHint') }}</div>
                      <q-input
                        v-model="projectForm.gitConventions"
                        type="textarea"
                        outlined
                        autogrow
                        :input-style="{ minHeight: '140px' }"
                        :placeholder="$t('settings.gitConventionsEmpty')"
                        class="settings-input mono-textarea"
                      />
                    </div>

                    <div>
                      <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">{{ $t('settings.taskPromptTemplate') }}</div>
                      <q-input
                        v-model="projectForm.taskPromptTemplate"
                        type="textarea"
                        outlined
                        autogrow
                        :input-style="{ minHeight: '100px' }"
                        :placeholder="$t('settings.taskPromptTemplatePlaceholder')"
                        class="settings-input"
                      />
                      <div class="text-caption text-grey-7 q-mt-xs">{{ $t('settings.taskPromptTemplateHint') }}</div>
                    </div>
                  </div>

                  <!-- Scripts -->
                  <div class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md">
                    <div class="text-subtitle2 q-mb-md">{{ $t('settings.projectGroup.scripts') }}</div>

                    <div class="q-mb-md">
                      <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">{{ $t('settings.setupScript') }}</div>
                      <div class="text-caption text-grey-7 q-mb-xs">{{ t('settings.initialPrompt.inheritHint') }}</div>
                      <q-input
                        v-model="projectForm.setupScript"
                        type="textarea"
                        outlined
                        autogrow
                        :input-style="{ minHeight: '100px' }"
                        :placeholder="$t('settings.setupScriptPlaceholder')"
                        class="settings-input mono-textarea"
                      />
                      <div class="text-caption text-grey-7 q-mt-xs">{{ $t('settings.setupScriptHint') }}</div>
                    </div>

                    <div class="q-mb-md">
                      <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">{{ $t('settings.cleanupScript') }}</div>
                      <div class="text-caption text-grey-7 q-mb-xs">{{ t('settings.initialPrompt.inheritHint') }}</div>
                      <q-input
                        v-model="projectForm.cleanupScript"
                        type="textarea"
                        outlined
                        autogrow
                        :input-style="{ minHeight: '100px' }"
                        :placeholder="$t('settings.cleanupScriptPlaceholder')"
                        class="settings-input mono-textarea"
                      />
                      <div class="field-label-sub text-caption q-mt-sm q-mb-xs text-grey-7">{{ $t('settings.cleanupScriptMode') }}</div>
                      <q-select
                        v-model="projectForm.cleanupScriptMode"
                        :options="cleanupModeProjectOptions"
                        emit-value
                        map-options
                        dense
                        outlined
                        class="settings-input"
                      />
                    </div>

                    <div>
                      <div class="field-label text-body2 text-weight-medium q-mb-xs text-grey-6">{{ $t('settings.archiveScript') }}</div>
                      <div class="text-caption text-grey-7 q-mb-xs">{{ t('settings.initialPrompt.inheritHint') }}</div>
                      <q-input
                        v-model="projectForm.archiveScript"
                        type="textarea"
                        outlined
                        autogrow
                        :input-style="{ minHeight: '100px' }"
                        :placeholder="$t('settings.archiveScriptPlaceholder')"
                        class="settings-input mono-textarea"
                      />
                    </div>

                    <div>
                      <div class="row items-center justify-between q-mb-xs">
                        <div class="field-label text-body2 text-weight-medium text-grey-6">{{ $t('settings.changeSourceBranchScript') }}</div>
                        <q-btn
                          flat
                          dense
                          no-caps
                          size="sm"
                          color="primary"
                          icon="restart_alt"
                          :label="$t('settings.changeSourceBranchScript.resetDefault')"
                          @click="insertDefaultChangeSourceBranchScript('project')"
                        />
                      </div>
                      <div class="text-caption text-grey-7 q-mb-xs">{{ $t('settings.changeSourceBranchScript.help') }}</div>
                      <pre class="text-caption text-grey-6 mono-guide q-mb-sm">{{ $t('settings.changeSourceBranchScript.envHelp') }}</pre>
                      <q-input
                        v-model="projectForm.changeSourceBranchScript"
                        type="textarea"
                        outlined
                        :input-style="{ minHeight: '400px', maxHeight: '600px' }"
                        :placeholder="$t('settings.changeSourceBranchScript.placeholder')"
                        class="settings-input mono-textarea"
                      />
                    </div>
                  </div>

                  <!-- Dev Server -->
                  <div class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md">
                    <div class="text-subtitle2 q-mb-md">{{ $t('settings.devServer') }}</div>
                    <div class="q-mb-md">
                      <div class="field-label-sub text-caption q-mb-xs text-grey-7">{{ $t('settings.devServerStart') }}</div>
                      <q-input
                        v-model="projectForm.devServer.startCommand"
                        type="textarea"
                        outlined
                        autogrow
                        :input-style="{ minHeight: '60px' }"
                        :placeholder="$t('settings.devServerStartPlaceholder')"
                        class="settings-input mono-textarea"
                      />
                    </div>
                    <div>
                      <div class="field-label-sub text-caption q-mb-xs text-grey-7">{{ $t('settings.devServerStop') }}</div>
                      <q-input
                        v-model="projectForm.devServer.stopCommand"
                        type="textarea"
                        outlined
                        autogrow
                        :input-style="{ minHeight: '60px' }"
                        :placeholder="$t('settings.devServerStopPlaceholder')"
                        class="settings-input mono-textarea"
                      />
                    </div>
                  </div>

                  <!-- E2E tests -->
                  <div class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md">
                    <div class="text-subtitle2 q-mb-xs">{{ $t('settings.e2e.title') }}</div>
                    <div class="text-caption text-grey-7 q-mb-sm">{{ $t('settings.e2e.helpText') }}</div>

                    <q-select
                      v-model="projectForm.e2e.framework"
                      :options="[
                        { label: $t('settings.e2e.frameworkNone'), value: '' },
                        { label: 'Cypress', value: 'cypress' },
                        { label: 'Playwright', value: 'playwright' },
                        { label: 'Jest', value: 'jest' },
                        { label: 'Vitest', value: 'vitest' },
                        { label: $t('settings.e2e.frameworkOther'), value: 'other' },
                      ]"
                      emit-value
                      map-options
                      dense
                      dark
                      outlined
                      class="settings-input q-mb-sm"
                      :label="$t('settings.e2e.framework')"
                    />

                    <template v-if="projectForm.e2e.framework">
                      <q-select
                        v-model="projectForm.e2e.skill"
                        :options="filteredSkills"
                        use-input
                        fill-input
                        hide-selected
                        hide-dropdown-icon
                        input-debounce="200"
                        new-value-mode="add-unique"
                        dense
                        dark
                        outlined
                        class="settings-input q-mb-sm"
                        :label="$t('settings.e2e.skill')"
                        :placeholder="$t('settings.e2e.skillPlaceholder')"
                        @filter="filterSkills"
                      />
                      <q-input
                        v-model="projectForm.e2e.prompt"
                        type="textarea"
                        autogrow
                        dense
                        dark
                        outlined
                        class="settings-input mono-textarea"
                        :label="$t('settings.e2e.prompt')"
                        :placeholder="$t('settings.e2e.promptPlaceholder')"
                      />
                    </template>
                  </div>

                  <!-- Auto-loop finalization -->
                  <div class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md">
                    <div class="text-subtitle2 q-mb-xs">{{ $t('settings.finalization.title') }}</div>
                    <div class="text-caption text-grey-7 q-mb-sm">
                      {{ $t('settings.finalization.helpText') }}
                    </div>
                    <q-input
                      v-model="projectForm.finalization.prompt"
                      type="textarea"
                      autogrow
                      rows="4"
                      dense
                      dark
                      outlined
                      class="settings-input mono-textarea q-mb-sm"
                      :label="$t('settings.finalization.prompt')"
                      :placeholder="$t('settings.finalization.promptPlaceholder')"
                    />
                  </div>

                  <!-- Actions — kept hidden (display:none); save is driven by the
                       floating settings-savebar, delete moved to the panel header. -->
                  <div class="row items-center q-gutter-sm settings-sticky-actions">
                    <q-space />
                    <q-btn
                      :label="$t('common.save')"
                      no-caps
                      unelevated
                      size="sm"
                      color="primary"
                      :loading="savingProject"
                      :class="{ 'save-btn--dirty': isProjectDirty }"
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
        </div>
        <!-- Templates panel -->
        <div v-show="activeTab === 'templates'" class="q-pa-none">
          <div data-tour="settings-card-templates" class="settings-card rounded-borders q-pa-lg">
            <div class="row items-center justify-between q-mb-md">
              <div class="text-subtitle1 text-weight-medium text-grey-3">
                {{ $t('templates.title') }}
              </div>
              <div class="row q-gutter-sm items-center">
                <q-btn
                  flat
                  color="grey-4"
                  icon="restart_alt"
                  :label="$t('templates.reloadDefaults')"
                  dense
                  no-caps
                  :loading="reloadingDefaults"
                  @click="confirmReloadDefaults"
                >
                  <q-tooltip>{{ $t('templates.reloadDefaultsHint') }}</q-tooltip>
                </q-btn>
                <q-btn
                  color="primary"
                  icon="add"
                  :label="$t('templates.newTemplate')"
                  dense
                  no-caps
                  @click="openCreateDialog"
                />
              </div>
            </div>

            <q-separator dark class="q-mb-md" />

            <div v-if="sortedTemplates.length === 0" class="text-grey-6 q-py-lg text-center">
              {{ $t('templates.empty') }}
            </div>

            <div v-else class="column q-gutter-sm">
              <q-card
                v-for="template in sortedTemplates"
                :key="template.slug"
                dark
                flat
                bordered
                class="q-pa-md template-card"
              >
                <div class="row items-start justify-between no-wrap">
                  <div class="col">
                    <div class="text-body1 text-weight-medium" style="font-family: 'Roboto Mono', monospace;">
                      /{{ template.slug }}
                    </div>
                    <div class="text-caption text-grey-5 q-mt-xs">{{ template.description }}</div>
                  </div>
                  <div class="row no-wrap q-gutter-xs">
                    <q-btn flat dense round size="sm" icon="edit" color="grey-5" @click="openEditDialog(template)">
                      <q-tooltip>{{ $t('templates.editTemplate') }}</q-tooltip>
                    </q-btn>
                    <q-btn flat dense round size="sm" icon="delete" color="red-4" @click="confirmDeleteTemplate(template)">
                      <q-tooltip>{{ $t('templates.deleteTemplate') }}</q-tooltip>
                    </q-btn>
                  </div>
                </div>
              </q-card>
            </div>

            <div class="text-caption text-grey-7 q-mt-lg" style="font-family: 'Roboto Mono', monospace;">
              {{ $t('templates.filePath', { path: '~/.config/kobo/templates.json' }) }}
            </div>
          </div>
        </div>
        </div>
      </main>

      <transition name="save-bar">
        <div v-if="savebarVisible" class="settings-savebar">
          <span class="settings-savebar__label">{{ $t('settings.unsavedChanges') }}</span>
          <q-btn
            dense
            no-caps
            unelevated
            class="settings-savebar__action"
            :loading="savebarLoading"
            :label="$t('common.save')"
            @click="savebarSave"
          />
        </div>
      </transition>
    </div>


    <!-- Templates create/edit dialog -->
    <q-dialog v-model="showTemplateDialog" persistent>
      <q-card dark style="min-width: 560px; max-width: 800px; width: 80vw;">
        <q-card-section>
          <div class="text-subtitle1">
            {{ editingSlug === null ? $t('templates.newTemplate') : $t('templates.editTemplate') }}
          </div>
        </q-card-section>

        <q-card-section class="q-gutter-md">
          <q-input
            v-model="formSlug"
            :label="$t('templates.slug')"
            :hint="$t('templates.slugHint')"
            dark
            dense
            prefix="/"
            :disable="editingSlug !== null"
            :rules="[(v) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(v) || $t('templates.slugInvalid')]"
            lazy-rules
          />
          <q-input
            v-model="formDescription"
            :label="$t('templates.description')"
            :hint="$t('templates.descriptionHint')"
            dark
            dense
            counter
            maxlength="120"
            :rules="[(v) => (v && v.trim().length > 0) || '']"
          />
          <q-input
            v-model="formContent"
            :label="$t('templates.content')"
            :hint="$t('templates.contentHint')"
            dark
            dense
            type="textarea"
            autogrow
            counter
            maxlength="4096"
            :rules="[(v) => (v && v.trim().length > 0) || '']"
          />
          <q-expansion-item
            dense
            dense-toggle
            :label="$t('templates.availableVars')"
            header-class="text-grey-6 text-caption q-pa-none"
            style="font-size: 11px;"
          >
            <div class="q-pl-md q-pt-xs" style="font-size: 11px; font-family: 'Roboto Mono', monospace; columns: 2; column-gap: 24px;">
              <div v-for="v in availableVarsDisplay" :key="v" class="text-grey-5 q-mb-xs">
                {{ v }}
              </div>
            </div>
          </q-expansion-item>
          <div v-if="formError" class="text-negative text-caption">{{ formError }}</div>
        </q-card-section>

        <q-card-actions align="right">
          <q-btn flat :label="$t('common.cancel')" v-close-popup />
          <q-btn
            flat
            color="primary"
            :label="editingSlug === null ? $t('templates.create') : $t('templates.save')"
            :loading="saving"
            @click="saveTemplate"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <FolderPickerDialog
      v-model="folderPickerOpen"
      :initial-path="projectForm.path"
      @select="onFolderPicked"
    />
  </q-page>
</template>

<script setup lang="ts">
import { type QInput, useQuasar } from 'quasar'
import FolderPickerDialog from 'src/components/FolderPickerDialog.vue'
import { useOnboarding } from 'src/composables/use-onboarding'
import { CODEX_MODEL_OPTION_DEFS, MODEL_OPTION_DEFS } from 'src/constants/models'
import { type AgentPermissionMode, PERMISSION_MODES_BY_ENGINE } from 'src/constants/permissionModes'
import type { ProjectSettings } from 'src/stores/settings'
import { useSettingsStore } from 'src/stores/settings'
import { type Template, useTemplatesStore } from 'src/stores/templates'
import { DEFAULT_NOTIFICATION_SOUND, NOTIFICATION_SOUNDS, resolveSoundId } from 'src/utils/notification-sounds'
import { playNotificationSound } from 'src/utils/notifications'
import { PROJECT_COLOR_PALETTE, type ProjectColor } from 'src/utils/project-color'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { WORKTREES_PATH } from '../../../shared/consts'
import {
  AGNOSTIC_AUTO_LOOP_GROOMING_INTRO,
  AGNOSTIC_AUTO_LOOP_REVIEW_GATE,
  AGNOSTIC_BRAINSTORMING_INSTRUCTION,
  AGNOSTIC_QA_PROMPT_TEMPLATE,
  AGNOSTIC_REVIEW_TEMPLATE,
  type SkillSuite,
} from '../../../shared/skill-suite-prompts'

const $q = useQuasar()
const store = useSettingsStore()
const templatesStore = useTemplatesStore()
const { t, locale } = useI18n()
const { startTour } = useOnboarding()

// Tab state
const activeTab = ref('general')

const navItems = computed(() => [
  { value: 'general', icon: 'tune', label: t('settings.nav.general') },
  { value: 'agents', icon: 'smart_toy', label: t('settings.nav.agents') },
  { value: 'skills', icon: 'extension', label: t('settings.nav.skills') },
  { value: 'prompts', icon: 'text_snippet', label: t('settings.nav.prompts') },
  { value: 'scripts', icon: 'terminal', label: t('settings.nav.scripts') },
  { value: 'notion', icon: 'integration_instructions', label: t('settings.nav.notion') },
  { value: 'sentry', icon: 'bug_report', label: t('settings.nav.sentry') },
  { value: 'voice', icon: 'mic', label: t('settings.nav.voice') },
  { value: 'notifications', icon: 'notifications', label: t('settings.nav.notifications') },
  { value: 'worktrees', icon: 'account_tree', label: t('settings.nav.worktrees') },
  { value: 'projects', icon: 'folder', label: t('settings.projects') },
  { value: 'templates', icon: 'description', label: t('templates.title') },
  { value: 'export', icon: 'import_export', label: t('settings.nav.export') },
])
const activeNavLabel = computed(() => navItems.value.find((i) => i.value === activeTab.value)?.label ?? '')

const isGlobalSection = computed(() =>
  [
    'general',
    'agents',
    'skills',
    'prompts',
    'scripts',
    'notion',
    'sentry',
    'voice',
    'notifications',
    'worktrees',
    'export',
  ].includes(activeTab.value),
)

// Global form
const globalClaudeModel = ref('auto')
const globalCodexModel = ref('auto')
const globalPrPrompt = ref('')
const globalReviewPrompt = ref('')
const globalCiFixPrompt = ref('')
const globalGitConventions = ref('')
const globalEditorCommand = ref('')
const globalBrowserNotifications = ref(true)
const globalAudioNotifications = ref(true)
const globalAudioNotificationSound = ref(DEFAULT_NOTIFICATION_SOUND)
const globalAudioNotificationVolume = ref(1)
const globalNotionStatusProperty = ref('')
const globalNotionStatus = ref('')
const globalNotionAssigneeProperty = ref('')
const globalNotionUserId = ref('')

interface NotionUserOption {
  id: string
  name: string
  email: string
  avatarUrl: string | null
}
const notionUsers = ref<NotionUserOption[]>([])
const loadingNotionUsers = ref(false)
const notionUsersError = ref('')
const notionUserOptions = computed(() =>
  notionUsers.value.map((u) => ({
    label: `${u.name} — ${u.email}`,
    value: u.id,
    name: u.name,
    email: u.email,
    avatarUrl: u.avatarUrl,
  })),
)

async function loadNotionUsers(force = false) {
  if (loadingNotionUsers.value) return
  if (!force && notionUsers.value.length > 0) return
  loadingNotionUsers.value = true
  notionUsersError.value = ''
  try {
    const res = await fetch('/api/notion/users')
    const body = (await res.json().catch(() => ({}))) as { users?: NotionUserOption[]; error?: string }
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    notionUsers.value = Array.isArray(body.users) ? body.users : []
  } catch (err) {
    notionUsersError.value = err instanceof Error ? err.message : String(err)
    notionUsers.value = []
  } finally {
    loadingNotionUsers.value = false
  }
}
const globalNotionInitialPrompt = ref('')
const globalSentryInitialPrompt = ref('')
type ResettableField =
  | 'prPromptTemplate'
  | 'reviewPromptTemplate'
  | 'ciFixPromptTemplate'
  | 'gitConventions'
  | 'notionInitialPromptTemplate'
  | 'sentryInitialPromptTemplate'
const resettingField = ref<ResettableField | null>(null)
const globalClaudePermissionMode = ref<AgentPermissionMode>('bypass')
const globalCodexPermissionMode = ref<AgentPermissionMode>('bypass')
const globalNotionMcpKey = ref('')
const globalSentryMcpKey = ref('')
const globalTags = ref<string[]>([])
const globalBranchPrefixes = ref<string[]>([])
const newBranchPrefix = ref('')
const globalSetupScript = ref('')
const globalCleanupScript = ref('')
const globalCleanupScriptMode = ref<'idle' | 'no-tasks'>('no-tasks')
const globalCleanupScriptOnlyOnChanges = ref(false)
const globalArchiveScript = ref('')
const globalChangeSourceBranchScript = ref('')
// Hydrated at mount from GET /api/settings/defaults.
const defaultChangeSourceBranchScript = ref('')

// Folder picker dialog for the new-project path field.
const folderPickerOpen = ref(false)
function onFolderPicked(picked: string) {
  projectForm.value.path = picked
}

// Project-level cleanup mode select — includes an 'inherit global' entry.
const cleanupModeProjectOptions = computed(() => [
  { label: t('settings.cleanupScriptMode.inherit'), value: '' },
  { label: t('settings.cleanupScriptMode.idle'), value: 'idle' },
  { label: t('settings.cleanupScriptMode.noTasks'), value: 'no-tasks' },
])
const globalWorktreesPath = ref<string>(WORKTREES_PATH)
const globalWorktreesPathInput = ref<QInput | null>(null)
const globalWorktreesPrefixByProject = ref(true)

// ── Branch prefix CRUD ──────────────────────────────────────────────────────
// Mirror of the server-side `sanitizeBranchPrefixes` rules so invalid input is
// rejected before it reaches the API. Returns '' when the value is unusable.
function normalizeBranchPrefix(raw: string): string {
  const value = raw.trim().replace(/^\/+|\/+$/g, '')
  if (value.length === 0 || value.length > 50) return ''
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.includes('..')) return ''
  return value
}

function addBranchPrefix() {
  const value = normalizeBranchPrefix(newBranchPrefix.value)
  if (!value || globalBranchPrefixes.value.includes(value)) return
  globalBranchPrefixes.value.push(value)
  newBranchPrefix.value = ''
}

function removeBranchPrefix(index: number) {
  globalBranchPrefixes.value.splice(index, 1)
}

function updateBranchPrefix(index: number, raw: string) {
  const value = normalizeBranchPrefix(raw)
  if (!value) return
  // Reject a rename that would collide with another existing prefix.
  const existing = globalBranchPrefixes.value.indexOf(value)
  if (existing !== -1 && existing !== index) return
  globalBranchPrefixes.value[index] = value
}

function moveBranchPrefix(index: number, direction: -1 | 1) {
  const target = index + direction
  if (target < 0 || target >= globalBranchPrefixes.value.length) return
  const list = globalBranchPrefixes.value
  ;[list[index], list[target]] = [list[target], list[index]]
}
const globalFlattenWorkspaceList = ref(false)
const globalSkillSuite = ref<SkillSuite>('superpowers')
const skillSuiteHintKey = computed(() => {
  switch (globalSkillSuite.value) {
    case 'gstack':
      return 'settings.skillSuite.gstackHint'
    case 'superpowers+gstack':
      return 'settings.skillSuite.superpowersGstackHint'
    case 'custom':
      return 'settings.skillSuite.customHint'
    default:
      return 'settings.skillSuite.superpowersHint'
  }
})
const globalCustomReviewTemplate = ref('')
const globalCustomAutoLoopReviewGate = ref('')
const globalCustomAutoLoopGroomingIntro = ref('')
const globalCustomQaPromptTemplate = ref('')
const globalCustomBrainstormingInstruction = ref('')
const globalVoiceEnabled = ref(false)
const globalVoicePttKey = ref<'alt' | 'ctrl+space'>('alt')
const globalVoiceLanguage = ref('auto')
const globalVoiceModel = ref<string | null>(null)
const globalVoiceCommandPath = ref('')
const globalVoiceFfmpegPath = ref('')
const globalVoiceTemperature = ref(0)
const globalVoicePrompt = ref('')
const globalVoiceTranslateToEnglish = ref(false)
const globalVoiceSuppressNst = ref(true)
const voiceActionModel = ref<string | null>(null)
const hydratingVoiceForm = ref(false)

function confirmReloadCustomPrompts(): void {
  $q.dialog({
    title: t('settings.skillSuite.reloadDefaults'),
    message: t('settings.skillSuite.reloadDefaultsConfirm'),
    cancel: true,
    persistent: true,
    dark: true,
  }).onOk(() => {
    globalCustomReviewTemplate.value = AGNOSTIC_REVIEW_TEMPLATE
    globalCustomAutoLoopReviewGate.value = AGNOSTIC_AUTO_LOOP_REVIEW_GATE
    globalCustomAutoLoopGroomingIntro.value = AGNOSTIC_AUTO_LOOP_GROOMING_INTRO
    globalCustomQaPromptTemplate.value = AGNOSTIC_QA_PROMPT_TEMPLATE
    globalCustomBrainstormingInstruction.value = AGNOSTIC_BRAINSTORMING_INSTRUCTION
  })
}

/**
 * Reset a change-source-branch-script textarea to Kōbō's default. Used when
 * the user has edited the pre-filled default and wants to start over.
 * Confirms before overwriting a customised script; no-ops silently when the
 * field is already at the default (or empty).
 */
function insertDefaultChangeSourceBranchScript(target: 'global' | 'project'): void {
  const current =
    target === 'global' ? globalChangeSourceBranchScript.value : projectForm.value.changeSourceBranchScript
  const apply = (): void => {
    if (target === 'global') {
      globalChangeSourceBranchScript.value = defaultChangeSourceBranchScript.value
    } else {
      projectForm.value.changeSourceBranchScript = defaultChangeSourceBranchScript.value
    }
  }
  if (!current.trim() || current === defaultChangeSourceBranchScript.value) {
    apply()
    return
  }
  $q.dialog({
    title: t('settings.changeSourceBranchScript.replaceConfirmTitle'),
    message: t('settings.changeSourceBranchScript.replaceConfirm'),
    cancel: true,
    persistent: true,
    dark: true,
  }).onOk(apply)
}

function recommendedTemperatureForModel(modelName: string | null): number {
  if (!modelName) return 0.1
  if (modelName === 'tiny' || modelName === 'base') return 0.1
  if (modelName === 'small' || modelName === 'medium' || modelName === 'large-v3') return 0.2
  return 0.2
}
const worktreesPathRules = [(value: string) => value.trim().length > 0 || t('settings.worktreesPathRequired')]
const savingGlobal = ref(false)

// Project form
const selectedProjectIndex = ref(-1)
const isNewProject = ref(false)
const projectForm = ref({
  path: '',
  displayName: '',
  color: null as ProjectColor | null,
  defaultSourceBranch: '',
  defaultModel: '',
  forge: 'auto' as 'auto' | 'github' | 'gitlab' | 'none',
  prPromptTemplate: '',
  reviewPromptTemplate: '',
  ciFixPromptTemplate: '',
  notionInitialPromptTemplate: '',
  sentryInitialPromptTemplate: '',
  gitConventions: '',
  setupScript: '',
  taskPromptTemplate: '',
  cleanupScript: '',
  cleanupScriptMode: '' as '' | 'idle' | 'no-tasks',
  archiveScript: '',
  // Empty = inherit `global.changeSourceBranchScript`.
  changeSourceBranchScript: '',
  devServer: { startCommand: '', stopCommand: '' },
  e2e: { framework: '' as 'cypress' | 'playwright' | 'jest' | 'vitest' | 'other' | '', skill: '', prompt: '' },
  finalization: { prompt: '' },
})

// ── Copy-from-existing-project (clone) ─────────────────────────────────────
// Fields copied verbatim from the source project when "Copy from" is set.
// Excludes path/displayName/defaultSourceBranch — those stay user-filled.
const COPYABLE_FIELDS = [
  'defaultModel',
  'forge',
  'prPromptTemplate',
  'reviewPromptTemplate',
  'ciFixPromptTemplate',
  'notionInitialPromptTemplate',
  'sentryInitialPromptTemplate',
  'gitConventions',
  'setupScript',
  'taskPromptTemplate',
  'cleanupScript',
  'cleanupScriptMode',
  'archiveScript',
  'changeSourceBranchScript',
  'devServer',
  'e2e',
  'finalization',
] as const

const copyFromPath = ref<string | null>(null)
const previousCopyFromPath = ref<string | null>(null)

const copyFromOptions = computed(() =>
  store.projects.map((p) => ({
    value: p.path,
    label: projectDisplayName(p) || p.path,
  })),
)

function applyCopyFrom(sourcePath: string) {
  const source = store.projects.find((p) => p.path === sourcePath)
  if (!source) return
  // Mirror the defensive pattern of `syncProjectForm`: legacy projects in
  // settings.json may be missing nested objects (e.g. older e2e/finalization
  // schema), so always coalesce to a defined default. New nested objects also
  // ensure no reference is shared with the source project.
  projectForm.value.defaultModel = source.defaultModel ?? ''
  projectForm.value.forge = source.forge ?? 'auto'
  projectForm.value.prPromptTemplate = source.prPromptTemplate ?? ''
  projectForm.value.reviewPromptTemplate = source.reviewPromptTemplate ?? ''
  projectForm.value.ciFixPromptTemplate = source.ciFixPromptTemplate ?? ''
  projectForm.value.notionInitialPromptTemplate = source.notionInitialPromptTemplate ?? ''
  projectForm.value.sentryInitialPromptTemplate = source.sentryInitialPromptTemplate ?? ''
  projectForm.value.gitConventions = source.gitConventions ?? ''
  projectForm.value.setupScript = source.setupScript ?? ''
  projectForm.value.devServer = {
    startCommand: source.devServer?.startCommand ?? '',
    stopCommand: source.devServer?.stopCommand ?? '',
  }
  projectForm.value.e2e = {
    framework: source.e2e?.framework ?? '',
    skill: source.e2e?.skill ?? '',
    prompt: source.e2e?.prompt ?? '',
  }
  projectForm.value.finalization = {
    prompt: source.finalization?.prompt ?? '',
  }
}

function isFormPristine(): boolean {
  // Pristine when every COPYABLE_FIELDS value matches the empty-form default.
  // Defaults are inlined to match exactly what `syncProjectForm(null)` produces.
  const defaults: Record<string, unknown> = {
    defaultModel: '',
    forge: 'auto',
    prPromptTemplate: '',
    reviewPromptTemplate: '',
    notionInitialPromptTemplate: '',
    sentryInitialPromptTemplate: '',
    gitConventions: '',
    setupScript: '',
    taskPromptTemplate: '',
    cleanupScript: '',
    cleanupScriptMode: '',
    archiveScript: '',
    changeSourceBranchScript: '',
    devServer: { startCommand: '', stopCommand: '' },
    e2e: { framework: '', skill: '', prompt: '' },
    finalization: { prompt: '' },
  }
  return COPYABLE_FIELDS.every((key) => JSON.stringify(projectForm.value[key]) === JSON.stringify(defaults[key]))
}

function onCopyFromChange(newPath: string | null) {
  // Cas 1: clear → non-destructive, just remove the label
  if (newPath === null) {
    copyFromPath.value = null
    previousCopyFromPath.value = null
    return
  }

  // Cas 2: first selection on a pristine form → populate silently
  if (previousCopyFromPath.value === null && isFormPristine()) {
    applyCopyFrom(newPath)
    copyFromPath.value = newPath
    previousCopyFromPath.value = newPath
    return
  }

  // Cas 3: change or re-select → confirm before overwrite
  const target = store.projects.find((p) => p.path === newPath)
  const targetLabel = target ? projectDisplayName(target) || newPath : newPath
  $q.dialog({
    title: t('settings.copyFromConfirmTitle'),
    message: t('settings.copyFromConfirm', { project: targetLabel }),
    cancel: true,
    persistent: true,
    dark: true,
  })
    .onOk(() => {
      applyCopyFrom(newPath)
      copyFromPath.value = newPath
      previousCopyFromPath.value = newPath
    })
    .onCancel(() => {
      // Revert: q-select v-model already moved, force it back to the previous value.
      copyFromPath.value = previousCopyFromPath.value
    })
}

// Skills catalogue (fetched once, used for E2E skill autocomplete)
const availableSkills = ref<string[]>([])
const filteredSkills = ref<string[]>([])
async function fetchAvailableSkills() {
  try {
    const res = await fetch('/api/skills')
    if (res.ok) availableSkills.value = await res.json()
  } catch {
    /* non-fatal — autocomplete just stays empty */
  }
}
function filterSkills(input: string, update: (cb: () => void) => void) {
  update(() => {
    const needle = input.trim().toLowerCase()
    filteredSkills.value = needle
      ? availableSkills.value.filter((s) => s.toLowerCase().includes(needle))
      : availableSkills.value.slice()
  })
}

// Branch fetching for project form
const projectBranches = ref<string[]>([])
const loadingBranches = ref(false)
const savingProject = ref(false)
const deletingProject = ref(false)

// Templates dialog state
const showTemplateDialog = ref(false)
const editingSlug = ref<string | null>(null) // null = create mode
const formSlug = ref('')
const formDescription = ref('')
const formContent = ref('')
const formError = ref('')
const saving = ref(false)
const reloadingDefaults = ref(false)

const sortedTemplates = computed(() => [...templatesStore.templates].sort((a, b) => a.slug.localeCompare(b.slug)))

const availableVarsDisplay = [
  '{workspace_name}',
  '{working_branch}',
  '{source_branch}',
  '{project_path}',
  '{worktree_path}',
  '{commit_count}',
  '{unpushed_count}',
  '{files_changed}',
  '{insertions}',
  '{deletions}',
  '{pr_number}',
  '{pr_url}',
  '{pr_state}',
  '{session_name}',
]

function openCreateDialog() {
  editingSlug.value = null
  formSlug.value = ''
  formDescription.value = ''
  formContent.value = ''
  formError.value = ''
  showTemplateDialog.value = true
}

function openEditDialog(template: Template) {
  editingSlug.value = template.slug
  formSlug.value = template.slug
  formDescription.value = template.description
  formContent.value = template.content
  formError.value = ''
  showTemplateDialog.value = true
}

async function saveTemplate() {
  formError.value = ''
  const trimmedSlug = formSlug.value.trim()
  const trimmedDesc = formDescription.value.trim()
  // Explicit guard for create mode: slug field is free-form and q-input `:rules`
  // run on blur not on the save button, so an empty slug would sneak through.
  if (editingSlug.value === null && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(trimmedSlug)) {
    formError.value = t('templates.slugInvalid')
    return
  }
  if (!trimmedDesc) {
    formError.value = t('templates.descriptionRequired')
    return
  }
  if (!formContent.value.trim()) {
    formError.value = t('templates.contentRequired')
    return
  }
  saving.value = true
  try {
    if (editingSlug.value === null) {
      await templatesStore.createTemplate({
        slug: trimmedSlug,
        description: trimmedDesc,
        content: formContent.value, // keep user's whitespace for multiline prompts
      })
    } else {
      await templatesStore.updateTemplate(editingSlug.value, {
        description: trimmedDesc,
        content: formContent.value,
      })
    }
    showTemplateDialog.value = false
  } catch (err) {
    formError.value = err instanceof Error ? err.message : t('templates.createFailed')
  } finally {
    saving.value = false
  }
}

function confirmReloadDefaults() {
  $q.dialog({
    title: t('templates.reloadDefaults'),
    message: t('templates.reloadDefaultsConfirmMessage'),
    dark: true,
    cancel: { flat: true, label: t('common.cancel'), color: 'grey-5' },
    ok: { flat: true, label: t('templates.reloadDefaults'), color: 'primary' },
  }).onOk(async () => {
    reloadingDefaults.value = true
    try {
      const result = await templatesStore.reloadDefaults()
      $q.notify({
        type: 'positive',
        message: t('templates.reloadDefaultsSuccess', { added: result.added.length, kept: result.kept.length }),
        position: 'top',
        timeout: 4000,
      })
    } catch (err) {
      $q.notify({
        type: 'negative',
        message: err instanceof Error ? err.message : t('templates.reloadDefaultsFailed'),
        position: 'top',
      })
    } finally {
      reloadingDefaults.value = false
    }
  })
}

async function confirmDeleteTemplate(template: Template) {
  $q.dialog({
    title: t('templates.deleteTemplate'),
    message: `${t('templates.deleteConfirm', { slug: template.slug })}\n\n${t('templates.deleteConfirmMessage')}`,
    dark: true,
    cancel: { flat: true, label: t('common.cancel'), color: 'grey-5' },
    ok: { flat: true, label: t('templates.deleteTemplate'), color: 'red-5' },
  }).onOk(async () => {
    try {
      await templatesStore.deleteTemplate(template.slug)
    } catch (err) {
      $q.notify({
        type: 'negative',
        message: err instanceof Error ? err.message : t('templates.deleteFailed'),
        position: 'top',
      })
    }
  })
}

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

// Model options — split per engine. The Settings page exposes one selector
// per engine (each engine has its own catalogue), and the project-level
// selector keeps using the Claude catalogue (project default model is a
// single string applied only when it matches the chosen engine; see
// CreatePage's engine watcher for the runtime fallback).
const modelOptions = computed(() => [
  ...MODEL_OPTION_DEFS.map((option) => ({ label: t(option.i18nLabelKey), value: option.value })),
])

const codexModelOptions = computed(() => [
  ...CODEX_MODEL_OPTION_DEFS.map((option) => ({ label: t(option.i18nLabelKey), value: option.value })),
])

const projectModelOptions = computed(() => [{ label: t('settings.useGlobal'), value: '' }, ...modelOptions.value])

const forgeOptions = computed(() => [
  { label: t('settings.forge.auto'), value: 'auto' },
  { label: t('settings.forge.github'), value: 'github' },
  { label: t('settings.forge.gitlab'), value: 'gitlab' },
  { label: t('settings.forge.none'), value: 'none' },
])

// Permission-mode lists per engine — single source of truth in
// `constants/permissionModes.ts`, mirrored in backend capabilities. Codex
// supports `interactive` since the app-server migration (item/tool/requestUserInput
// gives real user-input round-trips); pulling from the constant ensures the
// Settings dropdowns stay in sync with CreatePage/WorkspacePage automatically.
const claudePermissionModeOptions = computed(() =>
  PERMISSION_MODES_BY_ENGINE['claude-code'].map((value) => ({
    label: t(`agentPermissionMode.${value}`),
    value,
  })),
)
const codexPermissionModeOptions = computed(() =>
  PERMISSION_MODES_BY_ENGINE.codex.map((value) => ({
    label: t(`agentPermissionMode.${value}`),
    value,
  })),
)

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

const mcpServerOptions = computed(() => [
  { label: t('settings.mcpAutoSelect'), value: '' },
  ...store.activeMcpServers.map((server) => ({
    label: server.key,
    value: server.key,
  })),
])

const soundSelectOptions = computed(() => NOTIFICATION_SOUNDS.map((s) => ({ label: t(s.labelKey), value: s.id })))
const voiceModelOptions = computed(() =>
  [{ label: t('voice.noneModel'), value: null }].concat(
    store.voiceModels.map((m) => ({
      label: m.installed ? `${m.name}` : `${m.name} (${t('voice.notInstalled')})`,
      value: m.name,
    })),
  ),
)
const voiceLanguageOptions = [
  { label: 'auto', value: 'auto' },
  { label: 'ar', value: 'ar' },
  { label: 'de', value: 'de' },
  { label: 'en', value: 'en' },
  { label: 'es', value: 'es' },
  { label: 'fr', value: 'fr' },
  { label: 'hi', value: 'hi' },
  { label: 'it', value: 'it' },
  { label: 'ja', value: 'ja' },
  { label: 'ko', value: 'ko' },
  { label: 'nl', value: 'nl' },
  { label: 'pl', value: 'pl' },
  { label: 'pt', value: 'pt' },
  { label: 'ru', value: 'ru' },
  { label: 'tr', value: 'tr' },
  { label: 'uk', value: 'uk' },
  { label: 'vi', value: 'vi' },
  { label: 'zh', value: 'zh' },
]

function previewNotificationSound(): void {
  playNotificationSound(globalAudioNotificationSound.value, globalAudioNotificationVolume.value)
}

// Selected project
const selectedProject = computed<ProjectSettings | null>(() => {
  if (selectedProjectIndex.value < 0 || selectedProjectIndex.value >= store.projects.length) {
    return null
  }
  return store.projects[selectedProjectIndex.value] ?? null
})

// Dirty-state tracking — snapshots of the saved form state captured at
// hydration and after each successful save. The Save buttons compare the
// current ref values against these snapshots to surface unsaved changes
// with an orange outline.
const globalSavedSnapshot = ref<string>('')
const projectSavedSnapshot = ref<string>('')

function captureGlobalSnapshot(): string {
  return JSON.stringify({
    claudeModel: globalClaudeModel.value,
    codexModel: globalCodexModel.value,
    prPrompt: globalPrPrompt.value,
    reviewPrompt: globalReviewPrompt.value,
    ciFixPrompt: globalCiFixPrompt.value,
    gitConventions: globalGitConventions.value,
    editorCommand: globalEditorCommand.value,
    browserNotifications: globalBrowserNotifications.value,
    audioNotifications: globalAudioNotifications.value,
    audioNotificationSound: globalAudioNotificationSound.value,
    audioNotificationVolume: globalAudioNotificationVolume.value,
    notionStatusProperty: globalNotionStatusProperty.value,
    notionStatus: globalNotionStatus.value,
    notionAssigneeProperty: globalNotionAssigneeProperty.value,
    notionUserId: globalNotionUserId.value,
    notionInitialPrompt: globalNotionInitialPrompt.value,
    sentryInitialPrompt: globalSentryInitialPrompt.value,
    claudePermissionMode: globalClaudePermissionMode.value,
    codexPermissionMode: globalCodexPermissionMode.value,
    notionMcpKey: globalNotionMcpKey.value,
    sentryMcpKey: globalSentryMcpKey.value,
    tags: globalTags.value,
    branchPrefixes: globalBranchPrefixes.value,
    setupScript: globalSetupScript.value,
    cleanupScript: globalCleanupScript.value,
    cleanupScriptMode: globalCleanupScriptMode.value,
    cleanupScriptOnlyOnChanges: globalCleanupScriptOnlyOnChanges.value,
    archiveScript: globalArchiveScript.value,
    changeSourceBranchScript: globalChangeSourceBranchScript.value,
    worktreesPath: globalWorktreesPath.value,
    worktreesPrefixByProject: globalWorktreesPrefixByProject.value,
    flattenWorkspaceList: globalFlattenWorkspaceList.value,
    skillSuite: globalSkillSuite.value,
    customReviewTemplate: globalCustomReviewTemplate.value,
    customAutoLoopReviewGate: globalCustomAutoLoopReviewGate.value,
    customAutoLoopGroomingIntro: globalCustomAutoLoopGroomingIntro.value,
    customQaPromptTemplate: globalCustomQaPromptTemplate.value,
    customBrainstormingInstruction: globalCustomBrainstormingInstruction.value,
    voiceEnabled: globalVoiceEnabled.value,
    voicePttKey: globalVoicePttKey.value,
    voiceLanguage: globalVoiceLanguage.value,
    voiceModel: globalVoiceModel.value,
    voiceCommandPath: globalVoiceCommandPath.value,
    voiceFfmpegPath: globalVoiceFfmpegPath.value,
    voiceTemperature: globalVoiceTemperature.value,
    voicePrompt: globalVoicePrompt.value,
    voiceTranslateToEnglish: globalVoiceTranslateToEnglish.value,
    voiceSuppressNst: globalVoiceSuppressNst.value,
  })
}

function captureProjectSnapshot(): string {
  return JSON.stringify(projectForm.value)
}

const isGlobalDirty = computed(() => captureGlobalSnapshot() !== globalSavedSnapshot.value)
const isProjectDirty = computed(() => captureProjectSnapshot() !== projectSavedSnapshot.value)

const savebarVisible = computed(() => {
  if (activeTab.value === 'projects')
    return isProjectDirty.value && (selectedProject.value !== null || isNewProject.value)
  if (activeTab.value === 'templates') return false
  return isGlobalDirty.value
})
const savebarLoading = computed(() => (activeTab.value === 'projects' ? savingProject.value : saving.value))
function savebarSave() {
  if (activeTab.value === 'projects') saveProject()
  else saveGlobal()
}

// Init global form from store
function syncGlobalForm() {
  hydratingVoiceForm.value = true
  const modelMap = store.global.defaultModelByEngine ?? {}
  globalClaudeModel.value = modelMap['claude-code'] ?? 'auto'
  globalCodexModel.value = modelMap.codex ?? 'auto'
  globalPrPrompt.value = store.global.prPromptTemplate
  globalReviewPrompt.value = store.global.reviewPromptTemplate ?? ''
  globalCiFixPrompt.value = store.global.ciFixPromptTemplate ?? ''
  globalGitConventions.value = store.global.gitConventions
  globalEditorCommand.value = store.global.editorCommand ?? ''
  globalBrowserNotifications.value = store.global.browserNotifications ?? true
  globalAudioNotifications.value = store.global.audioNotifications ?? true
  globalAudioNotificationSound.value = resolveSoundId(store.global.audioNotificationSound)
  const v = store.global.audioNotificationVolume
  globalAudioNotificationVolume.value = typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1
  globalNotionStatusProperty.value = store.global.notionStatusProperty ?? ''
  globalNotionStatus.value = store.global.notionInProgressStatus ?? ''
  globalNotionAssigneeProperty.value = store.global.notionAssigneeProperty ?? ''
  globalNotionUserId.value = store.global.notionUserId ?? ''
  globalNotionInitialPrompt.value = store.global.notionInitialPromptTemplate ?? ''
  globalSentryInitialPrompt.value = store.global.sentryInitialPromptTemplate ?? ''
  // Legacy/unknown values fall back to 'bypass' — safest non-plan default.
  {
    const modeMap = store.global.defaultPermissionModeByEngine ?? {}
    const isValidMode = (v: unknown): v is 'plan' | 'bypass' | 'strict' | 'interactive' =>
      v === 'plan' || v === 'bypass' || v === 'strict' || v === 'interactive'
    const claudeStored = modeMap['claude-code']
    globalClaudePermissionMode.value = isValidMode(claudeStored) ? claudeStored : 'bypass'
    const codexStored = modeMap.codex
    globalCodexPermissionMode.value = isValidMode(codexStored) ? codexStored : 'bypass'
  }
  globalNotionMcpKey.value = store.global.notionMcpKey ?? ''
  globalSentryMcpKey.value = store.global.sentryMcpKey ?? ''
  globalTags.value = Array.isArray(store.global.tags) ? [...store.global.tags] : []
  globalBranchPrefixes.value = Array.isArray(store.global.branchPrefixes) ? [...store.global.branchPrefixes] : []
  globalSetupScript.value = store.global.setupScript ?? ''
  globalCleanupScript.value = store.global.cleanupScript ?? ''
  globalCleanupScriptMode.value = store.global.cleanupScriptMode === 'idle' ? 'idle' : 'no-tasks'
  globalCleanupScriptOnlyOnChanges.value = store.global.cleanupScriptOnlyOnChanges ?? false
  globalArchiveScript.value = store.global.archiveScript ?? ''
  globalChangeSourceBranchScript.value = store.global.changeSourceBranchScript ?? ''
  globalWorktreesPath.value = store.global.worktreesPath ?? WORKTREES_PATH
  globalWorktreesPrefixByProject.value = store.global.worktreesPrefixByProject ?? false
  globalFlattenWorkspaceList.value = store.global.flattenWorkspaceList ?? false
  globalSkillSuite.value = store.global.skillSuite ?? 'superpowers'
  globalCustomReviewTemplate.value = store.global.customReviewTemplate ?? ''
  globalCustomAutoLoopReviewGate.value = store.global.customAutoLoopReviewGate ?? ''
  globalCustomAutoLoopGroomingIntro.value = store.global.customAutoLoopGroomingIntro ?? ''
  globalCustomQaPromptTemplate.value = store.global.customQaPromptTemplate ?? ''
  globalCustomBrainstormingInstruction.value = store.global.customBrainstormingInstruction ?? ''
  globalVoiceEnabled.value = store.global.voiceEnabled ?? false
  globalVoicePttKey.value = store.global.voicePttKey === 'ctrl+space' ? 'ctrl+space' : 'alt'
  globalVoiceLanguage.value = store.global.voiceLanguage ?? 'auto'
  globalVoiceModel.value = store.global.voiceModel ?? null
  globalVoiceCommandPath.value = store.global.voiceCommandPath ?? ''
  globalVoiceFfmpegPath.value = store.global.voiceFfmpegPath ?? ''
  globalVoiceTemperature.value = typeof store.global.voiceTemperature === 'number' ? store.global.voiceTemperature : 0
  globalVoicePrompt.value = store.global.voicePrompt ?? ''
  globalVoiceTranslateToEnglish.value = store.global.voiceTranslateToEnglish ?? false
  globalVoiceSuppressNst.value = store.global.voiceSuppressNonSpeechTokens ?? true
  hydratingVoiceForm.value = false
  globalSavedSnapshot.value = captureGlobalSnapshot()
}

watch(
  () => globalVoiceModel.value,
  (next, prev) => {
    if (hydratingVoiceForm.value) return
    if (next === prev) return
    globalVoiceTemperature.value = recommendedTemperatureForModel(next)
  },
)

// Init project form from selected project
function syncProjectForm(project: ProjectSettings | null) {
  if (!project) {
    projectForm.value = {
      path: '',
      displayName: '',
      color: null,
      defaultSourceBranch: '',
      defaultModel: '',
      forge: 'auto',
      prPromptTemplate: '',
      reviewPromptTemplate: '',
      ciFixPromptTemplate: '',
      notionInitialPromptTemplate: '',
      sentryInitialPromptTemplate: '',
      gitConventions: '',
      setupScript: '',
      taskPromptTemplate: '',
      cleanupScript: '',
      cleanupScriptMode: '',
      archiveScript: '',
      changeSourceBranchScript: '',
      devServer: { startCommand: '', stopCommand: '' },
      e2e: { framework: '', skill: '', prompt: '' },
      finalization: { prompt: '' },
    }
    projectBranches.value = []
    projectSavedSnapshot.value = captureProjectSnapshot()
    return
  }
  projectForm.value = {
    path: project.path,
    displayName: project.displayName,
    color: project.color ?? null,
    defaultSourceBranch: project.defaultSourceBranch,
    defaultModel: project.defaultModel,
    forge: project.forge ?? 'auto',
    prPromptTemplate: project.prPromptTemplate,
    reviewPromptTemplate: project.reviewPromptTemplate ?? '',
    ciFixPromptTemplate: project.ciFixPromptTemplate ?? '',
    notionInitialPromptTemplate: project.notionInitialPromptTemplate ?? '',
    sentryInitialPromptTemplate: project.sentryInitialPromptTemplate ?? '',
    gitConventions: project.gitConventions ?? '',
    setupScript: project.setupScript ?? '',
    taskPromptTemplate: project.taskPromptTemplate ?? '',
    cleanupScript: project.cleanupScript ?? '',
    cleanupScriptMode: project.cleanupScriptMode ?? '',
    archiveScript: project.archiveScript ?? '',
    changeSourceBranchScript: project.changeSourceBranchScript ?? '',
    devServer: {
      startCommand: project.devServer?.startCommand ?? '',
      stopCommand: project.devServer?.stopCommand ?? '',
    },
    e2e: {
      framework: project.e2e?.framework ?? '',
      skill: project.e2e?.skill ?? '',
      prompt: project.e2e?.prompt ?? '',
    },
    finalization: {
      prompt: project.finalization?.prompt ?? '',
    },
  }
  projectSavedSnapshot.value = captureProjectSnapshot()
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
const importFileInput = ref<HTMLInputElement | null>(null)

async function exportConfig() {
  try {
    const res = await fetch('/api/settings/export')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `kobo-config-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    a.click()
    URL.revokeObjectURL(url)
    $q.notify({ type: 'positive', message: t('settings.exportSuccess'), position: 'top', timeout: 3000 })
  } catch (err) {
    $q.notify({ type: 'negative', message: String(err), position: 'top', timeout: 4000 })
  }
}

function triggerImport() {
  importFileInput.value?.click()
}

async function onImportFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    $q.dialog({
      title: t('settings.importConfirmTitle'),
      message: t('settings.importConfirmMessage'),
      cancel: true,
      persistent: true,
      dark: true,
    }).onOk(async () => {
      try {
        const text = await file.text()
        const bundle = JSON.parse(text)
        const res = await fetch('/api/settings/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bundle),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? `HTTP ${res.status}`)
        }
        await store.fetchSettings()
        syncGlobalForm()
        $q.notify({ type: 'positive', message: t('settings.importSuccess'), position: 'top', timeout: 3000 })
      } catch (err) {
        $q.notify({ type: 'negative', message: String(err), position: 'top', timeout: 5000 })
      }
    })
  } finally {
    input.value = ''
  }
}

async function resetFieldToDefault(field: ResettableField) {
  if (resettingField.value !== null) return
  resettingField.value = field
  try {
    const defaults = await store.fetchGlobalDefaults()
    const target: Record<ResettableField, typeof globalPrPrompt> = {
      prPromptTemplate: globalPrPrompt,
      reviewPromptTemplate: globalReviewPrompt,
      ciFixPromptTemplate: globalCiFixPrompt,
      gitConventions: globalGitConventions,
      notionInitialPromptTemplate: globalNotionInitialPrompt,
      sentryInitialPromptTemplate: globalSentryInitialPrompt,
    }
    target[field].value = defaults[field]
  } catch (err) {
    console.error('[SettingsPage] resetFieldToDefault failed:', err)
    $q.notify({ type: 'negative', message: t('settings.resetFailed'), position: 'top' })
  } finally {
    resettingField.value = null
  }
}

async function saveGlobal() {
  const worktreesPathValid = await globalWorktreesPathInput.value?.validate()
  if (worktreesPathValid === false) return

  savingGlobal.value = true
  try {
    await store.updateGlobal({
      defaultModelByEngine: {
        'claude-code': globalClaudeModel.value,
        codex: globalCodexModel.value,
      },
      prPromptTemplate: globalPrPrompt.value,
      reviewPromptTemplate: globalReviewPrompt.value,
      ciFixPromptTemplate: globalCiFixPrompt.value,
      gitConventions: globalGitConventions.value,
      editorCommand: globalEditorCommand.value,
      browserNotifications: globalBrowserNotifications.value,
      audioNotifications: globalAudioNotifications.value,
      audioNotificationSound: globalAudioNotificationSound.value,
      audioNotificationVolume: globalAudioNotificationVolume.value,
      notionStatusProperty: globalNotionStatusProperty.value,
      notionInProgressStatus: globalNotionStatus.value,
      notionAssigneeProperty: globalNotionAssigneeProperty.value,
      notionUserId: globalNotionUserId.value,
      notionInitialPromptTemplate: globalNotionInitialPrompt.value,
      sentryInitialPromptTemplate: globalSentryInitialPrompt.value,
      defaultPermissionModeByEngine: {
        'claude-code': globalClaudePermissionMode.value,
        codex: globalCodexPermissionMode.value,
      },
      notionMcpKey: globalNotionMcpKey.value,
      sentryMcpKey: globalSentryMcpKey.value,
      tags: globalTags.value,
      branchPrefixes: globalBranchPrefixes.value,
      setupScript: globalSetupScript.value,
      cleanupScript: globalCleanupScript.value,
      cleanupScriptMode: globalCleanupScriptMode.value,
      cleanupScriptOnlyOnChanges: globalCleanupScriptOnlyOnChanges.value,
      archiveScript: globalArchiveScript.value,
      changeSourceBranchScript: globalChangeSourceBranchScript.value,
      worktreesPath: globalWorktreesPath.value,
      worktreesPrefixByProject: globalWorktreesPrefixByProject.value,
      flattenWorkspaceList: globalFlattenWorkspaceList.value,
      skillSuite: globalSkillSuite.value,
      customReviewTemplate: globalCustomReviewTemplate.value,
      customAutoLoopReviewGate: globalCustomAutoLoopReviewGate.value,
      customAutoLoopGroomingIntro: globalCustomAutoLoopGroomingIntro.value,
      customQaPromptTemplate: globalCustomQaPromptTemplate.value,
      customBrainstormingInstruction: globalCustomBrainstormingInstruction.value,
      voiceEnabled: globalVoiceEnabled.value,
      voicePttKey: globalVoicePttKey.value,
      voiceLanguage: globalVoiceLanguage.value,
      voiceModel: globalVoiceModel.value,
      voiceCommandPath: globalVoiceCommandPath.value.trim(),
      voiceFfmpegPath: globalVoiceFfmpegPath.value.trim(),
      voiceTemperature: globalVoiceTemperature.value,
      voicePrompt: globalVoicePrompt.value,
      voiceTranslateToEnglish: globalVoiceTranslateToEnglish.value,
      voiceSuppressNonSpeechTokens: globalVoiceSuppressNst.value,
    })
    globalSavedSnapshot.value = captureGlobalSnapshot()
    $q.notify({ type: 'positive', message: t('settings.saved'), position: 'top' })
  } catch {
    $q.notify({ type: 'negative', message: t('settings.saveError'), position: 'top' })
  } finally {
    savingGlobal.value = false
  }
}

async function installVoiceModel(name: string) {
  voiceActionModel.value = name
  startVoiceModelsPolling()
  try {
    await store.downloadVoiceModel(name)
  } catch {
    $q.notify({ type: 'negative', message: t('voice.downloadFailed'), position: 'top' })
  } finally {
    voiceActionModel.value = null
    stopVoiceModelsPolling()
  }
}

async function removeVoiceModel(name: string) {
  voiceActionModel.value = name
  try {
    await store.deleteVoiceModel(name)
    if (globalVoiceModel.value === name) globalVoiceModel.value = null
  } catch {
    $q.notify({ type: 'negative', message: t('voice.deleteFailed'), position: 'top' })
  } finally {
    voiceActionModel.value = null
  }
}

async function cancelVoiceDownload(name: string) {
  try {
    await store.cancelVoiceModelDownload(name)
  } catch {
    $q.notify({ type: 'negative', message: t('voice.cancelFailed'), position: 'top' })
  }
}

function formatBytes(bytes: number | undefined | null): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}

let voiceModelsPollTimer: ReturnType<typeof setInterval> | null = null
function startVoiceModelsPolling() {
  if (voiceModelsPollTimer) return
  voiceModelsPollTimer = setInterval(() => {
    store.fetchVoiceModels().catch(() => {})
  }, 800)
}
function stopVoiceModelsPolling() {
  if (voiceModelsPollTimer) {
    clearInterval(voiceModelsPollTimer)
    voiceModelsPollTimer = null
  }
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    $q.notify({ type: 'positive', message: t('common.copied'), position: 'top', timeout: 1200 })
  } catch {
    $q.notify({ type: 'negative', message: t('common.copyFailed'), position: 'top' })
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
      color: projectForm.value.color,
      defaultSourceBranch: projectForm.value.defaultSourceBranch,
      defaultModel: projectForm.value.defaultModel,
      forge: projectForm.value.forge,
      prPromptTemplate: projectForm.value.prPromptTemplate,
      reviewPromptTemplate: projectForm.value.reviewPromptTemplate,
      ciFixPromptTemplate: projectForm.value.ciFixPromptTemplate,
      notionInitialPromptTemplate: projectForm.value.notionInitialPromptTemplate,
      sentryInitialPromptTemplate: projectForm.value.sentryInitialPromptTemplate,
      gitConventions: projectForm.value.gitConventions,
      setupScript: projectForm.value.setupScript,
      taskPromptTemplate: projectForm.value.taskPromptTemplate,
      cleanupScript: projectForm.value.cleanupScript,
      cleanupScriptMode: projectForm.value.cleanupScriptMode,
      archiveScript: projectForm.value.archiveScript,
      changeSourceBranchScript: projectForm.value.changeSourceBranchScript,
      devServer: projectForm.value.devServer,
      e2e: projectForm.value.e2e,
      finalization: projectForm.value.finalization,
    })
    isNewProject.value = false
    // Select the project we just saved
    const idx = store.projects.findIndex((p) => p.path === projectForm.value.path.trim())
    if (idx >= 0) selectedProjectIndex.value = idx
    projectSavedSnapshot.value = captureProjectSnapshot()
    $q.notify({ type: 'positive', message: t('settings.projectSaved'), position: 'top' })
  } catch {
    $q.notify({ type: 'negative', message: t('settings.projectSaveError'), position: 'top' })
  } finally {
    savingProject.value = false
  }
}

// Delete project
function deleteProject() {
  if (!selectedProject.value) return
  const projectName = selectedProject.value.displayName || selectedProject.value.path
  $q.dialog({
    title: t('settings.deleteProjectConfirmTitle'),
    message: t('settings.deleteProjectConfirmMessage', { name: projectName }),
    dark: true,
    cancel: { flat: true, label: t('common.cancel'), color: 'grey-5' },
    ok: { flat: true, label: t('common.delete'), color: 'red-5' },
  }).onOk(async () => {
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
  })
}

// Add new project
function addNewProject() {
  selectedProjectIndex.value = -1
  isNewProject.value = true
  syncProjectForm(null)
  copyFromPath.value = null
  previousCopyFromPath.value = null
}

// Select a project from the list
function selectProject(index: number) {
  isNewProject.value = false
  selectedProjectIndex.value = index
  copyFromPath.value = null
  previousCopyFromPath.value = null
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
  await Promise.all([store.fetchSettings(), store.fetchActiveMcpServers(), fetchAvailableSkills()])
  try {
    const defaults = await store.fetchGlobalDefaults()
    defaultChangeSourceBranchScript.value = defaults.changeSourceBranchScript ?? ''
  } catch (err) {
    console.error('[SettingsPage] fetchGlobalDefaults failed:', err)
  }
  await store.fetchVoiceModels()
  await store.fetchVoiceRuntime()
  syncGlobalForm()
  loadNotionUsers().catch(() => {})
})

// Cleanup debounce timer on unmount
onUnmounted(() => {
  if (pathDebounce) clearTimeout(pathDebounce)
  stopVoiceModelsPolling()
})
</script>

<style lang="scss" scoped>
.settings-page.q-page {
  background-color: var(--kobo-bg);
  position: relative;
  padding: 0;
  min-height: 100vh;
}

.settings-layout {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: stretch;
  overflow: hidden;
}

.settings-nav {
  width: 240px;
  flex-shrink: 0;
  background-color: var(--kobo-surface);
  border-right: 1px solid var(--kobo-border-subtle);
  padding: 24px 12px;
  overflow-y: auto;
}

.settings-nav__title {
  font-family: var(--kobo-font-sans);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--kobo-text-3);
  padding: 0 12px;
  margin-bottom: 16px;
}

.settings-nav__list {
  padding: 0;
}

.settings-nav__item {
  border-radius: var(--kobo-radius-sm);
  padding: 6px 12px;
  color: var(--kobo-text-2);
  font-size: 13px;
  font-weight: 500;
  min-height: 30px;
  transition: background-color var(--kobo-duration-micro) var(--kobo-ease-out),
              color var(--kobo-duration-micro) var(--kobo-ease-out);

  &:hover {
    background-color: var(--kobo-hover);
    color: var(--kobo-text);
  }
}

.settings-nav__item--active {
  background-color: var(--kobo-hover);
  color: var(--kobo-text);
  position: relative;

  &::before {
    content: '';
    position: absolute;
    left: -8px;
    top: 6px;
    bottom: 6px;
    width: 2px;
    background-color: var(--kobo-accent);
    border-radius: 1px;
  }
}

.settings-nav__icon {
  min-width: 24px;
  color: inherit;
}

.settings-nav__label {
  padding-left: 4px;
}

.settings-content {
  flex: 1;
  min-width: 0;
  padding: 24px 32px 80px;
  overflow-y: auto;
}

.settings-content__header {
  margin-bottom: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--kobo-border-subtle);
  position: sticky;
  top: -24px;
  background-color: var(--kobo-bg);
  margin-top: -24px;
  padding-top: 24px;
  z-index: 2;
}

.settings-content__title {
  font-family: var(--kobo-font-sans);
  font-size: 22px;
  font-weight: 600;
  color: var(--kobo-text);
  margin: 0;
  line-height: 1.2;
}

.settings-panels {
  background: transparent;
}

.settings-global-wrap {
  display: block;
}

.settings-card {
  background: var(--kobo-surface);
  border: 1px solid var(--kobo-border-subtle);
  border-radius: var(--kobo-radius-md);
}

.settings-subcard {
  background: var(--kobo-surface);
  border: 1px solid var(--kobo-border-subtle);
  border-radius: var(--kobo-radius-md);
  margin-bottom: 16px;
}

.voice-model-row {
  background: var(--kobo-surface-2);
  border: 1px solid var(--kobo-border-subtle);
  transition: border-color var(--kobo-duration-short) var(--kobo-ease-out);
}

.voice-model-row--active {
  border-color: var(--kobo-accent);
}

.voice-models-dir {
  background: var(--kobo-surface-2);
  border: 1px solid var(--kobo-border-subtle);
  border-radius: var(--kobo-radius-sm);
  padding: 6px 10px;
}

.template-card {
  background: var(--kobo-surface);
  border: 1px solid var(--kobo-border-subtle);
}

// field-label: font-size and font-weight moved to template (text-body2 text-weight-medium)

// field-label-sub: font-size moved to template (text-caption)

.settings-input {
  :deep(.q-field__control) {
    background: var(--kobo-surface-2);
    border-color: var(--kobo-border-subtle);
  }

  :deep(.q-field__native),
  :deep(input),
  :deep(textarea) {
    color: var(--kobo-text);
  }

  :deep(.q-field__label) {
    color: var(--kobo-text-3);
  }
}

.mono-textarea {
  :deep(textarea) {
    font-family: var(--kobo-font-mono);
    font-size: 13px;
  }
}

.mono-guide {
  margin: 0;
  white-space: pre-wrap;
  background: var(--kobo-surface-2);
  border: 1px solid var(--kobo-border-subtle);
  border-radius: var(--kobo-radius-sm);
  padding: 8px 10px;
  font-family: var(--kobo-font-mono);
  font-size: 12px;
  line-height: 1.35;
  color: var(--kobo-text-2);
}

.readonly-input {
  :deep(.q-field__control) {
    background: var(--kobo-bg);
  }

  :deep(input) {
    color: var(--kobo-text-3);
  }
}

.project-list-col {
  width: 30%;
  min-width: 200px;
  max-width: 280px;
  flex-shrink: 0;
  overflow: hidden;
  position: sticky;
  top: 0;
  align-self: flex-start;
  max-height: calc(100vh - 140px);
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

.settings-sticky-actions {
  display: none;
}

.project-item--active {
  background-color: var(--kobo-hover) !important;
  border-left: 2px solid var(--kobo-accent);
}

.save-btn--dirty {
  box-shadow: 0 0 0 2px var(--kobo-accent) !important;
  border-radius: var(--kobo-radius-sm);
  transition: box-shadow var(--kobo-duration-short) var(--kobo-ease-out);
}

.settings-savebar {
  position: absolute;
  bottom: 0;
  left: 240px;
  right: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 32px;
  background-color: var(--kobo-surface);
  border-top: 1px solid var(--kobo-border-subtle);
}

.settings-savebar__label {
  font-family: var(--kobo-font-sans);
  font-size: 13px;
  font-weight: 500;
  color: var(--kobo-text-2);
}

.settings-savebar__action {
  background-color: var(--kobo-accent) !important;
  color: var(--kobo-accent-fg) !important;
  font-weight: 500;
  font-size: 13px;
  padding: 6px 16px;
  border-radius: var(--kobo-radius-sm);

  &:hover {
    background-color: var(--kobo-accent-hover) !important;
  }
}

.save-bar-enter-active,
.save-bar-leave-active {
  transition: transform var(--kobo-duration-medium) var(--kobo-ease-out),
              opacity var(--kobo-duration-medium) var(--kobo-ease-out);
}

.save-bar-enter-from,
.save-bar-leave-to {
  transform: translateY(100%);
  opacity: 0;
}
</style>
