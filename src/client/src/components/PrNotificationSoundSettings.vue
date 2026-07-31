<template>
  <div class="q-mt-md">
    <div class="text-subtitle2 q-mb-sm">{{ t('settings.prSoundSection') }}</div>
    <div v-for="row in rows" :key="row.key" class="row items-center q-gutter-sm q-mt-xs">
      <q-select
        :model-value="modelValue[row.key]"
        :options="soundOptions"
        :label="row.label"
        :disable="disabled"
        dark
        dense
        outlined
        emit-value
        map-options
        color="indigo-4"
        class="col"
        @update:model-value="update(row.key, String($event))"
      />
      <q-btn
        flat
        dense
        color="indigo-4"
        icon="play_arrow"
        :label="t('settings.notificationSoundPreview')"
        :disable="disabled || modelValue[row.key] === NO_NOTIFICATION_SOUND"
        @click="preview(modelValue[row.key])"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  INHERIT_NOTIFICATION_SOUND,
  NO_NOTIFICATION_SOUND,
  NOTIFICATION_SOUNDS,
  type PrNotificationSoundSettingKey,
  type PrNotificationSoundSettings,
  resolveNotificationSoundOverride,
} from 'src/utils/notification-sounds'
import { playNotificationSound } from 'src/utils/notifications'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  modelValue: PrNotificationSoundSettings
  disabled: boolean
  generalSound: string
  volume: number
}>()

const emit = defineEmits<{
  'update:modelValue': [value: PrNotificationSoundSettings]
}>()

const { t } = useI18n()

const rows = computed<Array<{ key: PrNotificationSoundSettingKey; label: string }>>(() => [
  { key: 'audioPrCiFailedSound', label: t('settings.prCiFailedSound') },
  { key: 'audioPrCiRecoveredSound', label: t('settings.prCiRecoveredSound') },
  { key: 'audioPrChangesRequestedSound', label: t('settings.prChangesRequestedSound') },
  { key: 'audioPrApprovedSound', label: t('settings.prApprovedSound') },
  { key: 'audioPrMergeConflictSound', label: t('settings.prMergeConflictSound') },
  { key: 'audioPrReadyToMergeSound', label: t('settings.prReadyToMergeSound') },
  { key: 'audioPrMergedSound', label: t('settings.prMergedSound') },
])

const soundOptions = computed(() => [
  { label: t('settings.soundGeneral'), value: INHERIT_NOTIFICATION_SOUND },
  { label: t('settings.soundNone'), value: NO_NOTIFICATION_SOUND },
  ...NOTIFICATION_SOUNDS.map((sound) => ({ label: t(sound.labelKey), value: sound.id })),
])

function update(key: PrNotificationSoundSettingKey, value: string): void {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}

function preview(selection: string): void {
  const override = resolveNotificationSoundOverride(selection)
  if (override === null) return
  playNotificationSound(override ?? props.generalSound, props.volume)
}
</script>
