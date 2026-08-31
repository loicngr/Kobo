<template>
  <div class="notification-sounds-grid q-mt-md">
    <div v-for="row in rows" :key="row.soundKey" class="notification-sound-card q-pa-md rounded-borders">
      <div class="text-subtitle2">{{ row.title }}</div>
      <div class="text-kobo-3 text-caption q-mb-sm">{{ row.description }}</div>
      <q-toggle
        :model-value="modelValue[row.enabledKey]"
        :label="t('settings.enableAudio')"
        dark
        dense
        color="primary"
        class="text-kobo-2 text-caption q-mb-sm"
        @update:model-value="update(row.enabledKey, Boolean($event))"
      />
      <div class="row items-center q-gutter-sm">
        <q-select
          :model-value="modelValue[row.soundKey]"
          :options="soundOptions"
          :label="row.title"
          :disable="!modelValue[row.enabledKey]"
          dark
          dense
          outlined
          emit-value
          map-options
          color="primary"
          class="col"
          @update:model-value="update(row.soundKey, String($event))"
        />
        <q-btn
          flat
          dense
          color="primary"
          icon="play_arrow"
          :label="t('settings.notificationSoundPreview')"
          :disable="!modelValue[row.enabledKey]"
          @click="preview(row)"
        />
      </div>
      <div class="row items-center q-gutter-sm q-mt-sm">
        <div class="text-kobo-2 text-caption volume-label">{{ t('settings.notificationVolume') }}</div>
        <q-slider
          :model-value="modelValue[row.volumeKey]"
          :min="0"
          :max="1"
          :step="0.05"
          :disable="!modelValue[row.enabledKey]"
          :aria-label="t('settings.notificationVolume')"
          dark
          dense
          color="primary"
          class="col"
          @update:model-value="update(row.volumeKey, Number($event))"
        />
        <div class="text-kobo-2 text-caption volume-value">
          {{ Math.round(modelValue[row.volumeKey] * 100) }}%
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  INHERIT_NOTIFICATION_SOUND,
  NOTIFICATION_SOUNDS,
  type PrNotificationAudioSettings,
  type PrNotificationSoundSettingKey,
  resolveNotificationSoundOverride,
} from 'src/utils/notification-sounds'
import { playNotificationSound } from 'src/utils/notifications'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

type EnabledKey = Extract<keyof PrNotificationAudioSettings, `${string}Enabled`>
type VolumeKey = Extract<keyof PrNotificationAudioSettings, `${string}Volume`>

interface PrSoundRow {
  soundKey: PrNotificationSoundSettingKey
  enabledKey: EnabledKey
  volumeKey: VolumeKey
  title: string
  description: string
}

const props = defineProps<{
  modelValue: PrNotificationAudioSettings
  generalSound: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: PrNotificationAudioSettings]
}>()

const { t } = useI18n()

const rows = computed<PrSoundRow[]>(() => [
  {
    soundKey: 'audioPrCiFailedSound',
    enabledKey: 'audioPrCiFailedEnabled',
    volumeKey: 'audioPrCiFailedVolume',
    title: t('settings.prCiFailedSound'),
    description: t('settings.prCiFailedSoundHint'),
  },
  {
    soundKey: 'audioPrCiRecoveredSound',
    enabledKey: 'audioPrCiRecoveredEnabled',
    volumeKey: 'audioPrCiRecoveredVolume',
    title: t('settings.prCiRecoveredSound'),
    description: t('settings.prCiRecoveredSoundHint'),
  },
  {
    soundKey: 'audioPrChangesRequestedSound',
    enabledKey: 'audioPrChangesRequestedEnabled',
    volumeKey: 'audioPrChangesRequestedVolume',
    title: t('settings.prChangesRequestedSound'),
    description: t('settings.prChangesRequestedSoundHint'),
  },
  {
    soundKey: 'audioPrApprovedSound',
    enabledKey: 'audioPrApprovedEnabled',
    volumeKey: 'audioPrApprovedVolume',
    title: t('settings.prApprovedSound'),
    description: t('settings.prApprovedSoundHint'),
  },
  {
    soundKey: 'audioPrMergeConflictSound',
    enabledKey: 'audioPrMergeConflictEnabled',
    volumeKey: 'audioPrMergeConflictVolume',
    title: t('settings.prMergeConflictSound'),
    description: t('settings.prMergeConflictSoundHint'),
  },
  {
    soundKey: 'audioPrReadyToMergeSound',
    enabledKey: 'audioPrReadyToMergeEnabled',
    volumeKey: 'audioPrReadyToMergeVolume',
    title: t('settings.prReadyToMergeSound'),
    description: t('settings.prReadyToMergeSoundHint'),
  },
  {
    soundKey: 'audioPrMergedSound',
    enabledKey: 'audioPrMergedEnabled',
    volumeKey: 'audioPrMergedVolume',
    title: t('settings.prMergedSound'),
    description: t('settings.prMergedSoundHint'),
  },
])

const soundOptions = computed(() => [
  { label: t('settings.soundGeneral'), value: INHERIT_NOTIFICATION_SOUND },
  ...NOTIFICATION_SOUNDS.map((sound) => ({ label: t(sound.labelKey), value: sound.id })),
])

function update(key: keyof PrNotificationAudioSettings, value: boolean | number | string): void {
  emit('update:modelValue', { ...props.modelValue, [key]: value } as PrNotificationAudioSettings)
}

function preview(row: PrSoundRow): void {
  const override = resolveNotificationSoundOverride(props.modelValue[row.soundKey])
  if (override === null) return
  playNotificationSound(override ?? props.generalSound, props.modelValue[row.volumeKey])
}
</script>

<style scoped>
.notification-sounds-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: 1fr;
}

.notification-sound-card {
  background: var(--kobo-surface-2);
  border: 1px solid var(--kobo-border-subtle);
}

.volume-label {
  min-width: 58px;
}

.volume-value {
  min-width: 40px;
  text-align: right;
}
</style>
