<template>
  <div class="custom-sounds" data-test="custom-sounds">
    <div class="text-subtitle2">{{ $t('settings.customSounds') }}</div>
    <div class="text-kobo-3 text-caption q-mb-sm">
      {{ $t('settings.customSoundsHint', { count: MAX_CUSTOM_SOUNDS, size: MAX_CUSTOM_SOUND_BYTES / 1024 / 1024 }) }}
    </div>

    <div class="row items-center q-gutter-sm">
      <input
        ref="fileInput"
        class="hidden"
        type="file"
        data-test="custom-sound-input"
        :accept="CUSTOM_SOUND_ACCEPT"
        :disabled="store.busy || full"
        @change="onSelect"
      />
      <q-btn
        flat
        dense
        no-caps
        color="primary"
        icon="library_music"
        :label="$t('settings.customSoundsImport')"
        :loading="store.busy"
        :disable="full"
        data-test="custom-sound-import"
        @click="fileInput?.click()"
      />
      <span v-if="full" class="text-kobo-3 text-caption">
        {{ $t('settings.customSoundsFull', { count: MAX_CUSTOM_SOUNDS }) }}
      </span>
    </div>

    <p v-if="error" class="text-negative text-caption q-mt-sm q-mb-none" role="alert">{{ error }}</p>

    <q-list v-if="store.sounds.length > 0" bordered separator class="rounded-borders q-mt-sm">
      <q-item v-for="sound in store.sounds" :key="sound.id">
        <q-item-section>
          <q-item-label class="ellipsis" :title="sound.name">{{ sound.name }}</q-item-label>
          <q-item-label caption>{{ Math.max(1, Math.round(sound.size / 1024)) }} KB</q-item-label>
        </q-item-section>
        <q-item-section side>
          <div class="row items-center no-wrap">
            <q-btn
              flat
              dense
              round
              size="sm"
              icon="play_arrow"
              color="primary"
              :aria-label="$t('settings.notificationSoundPreview')"
              @click="preview(sound.reference)"
            />
            <q-btn
              flat
              dense
              round
              size="sm"
              icon="delete"
              color="kobo-3"
              :disable="store.busy"
              :aria-label="$t('common.delete')"
              @click="remove(sound.id)"
            />
          </div>
        </q-item-section>
      </q-item>
    </q-list>
  </div>
</template>

<script setup lang="ts">
import { useCustomSoundsStore } from 'src/stores/custom-sounds'
import { ApiError } from 'src/utils/api'
import { playNotificationSound } from 'src/utils/notifications'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  CUSTOM_SOUND_ACCEPT,
  type CustomSoundErrorCode,
  customSoundExtension,
  MAX_CUSTOM_SOUND_BYTES,
  MAX_CUSTOM_SOUNDS,
} from '../../../shared/notification-assets'

const { t } = useI18n()
const store = useCustomSoundsStore()
const fileInput = ref<HTMLInputElement | null>(null)
const error = ref('')
const full = computed(() => store.sounds.length >= MAX_CUSTOM_SOUNDS)

const ERROR_CODES: readonly CustomSoundErrorCode[] = ['type', 'size', 'count']

function message(code: CustomSoundErrorCode): string {
  return t(`settings.customSoundsError.${code}`, {
    count: MAX_CUSTOM_SOUNDS,
    size: MAX_CUSTOM_SOUND_BYTES / 1024 / 1024,
  })
}

function describe(failure: unknown): string {
  if (!(failure instanceof ApiError)) return t('settings.customSoundsError.failed')
  // A body over the route limit is rejected by the framework, before the
  // service can attach its own code.
  if (failure.status === 413) return message('size')
  return ERROR_CODES.includes(failure.code as CustomSoundErrorCode)
    ? message(failure.code as CustomSoundErrorCode)
    : t('settings.customSoundsError.failed')
}

async function onSelect(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // Reset first: picking the same file twice must still fire `change`.
  input.value = ''
  if (!file) return
  error.value = ''
  // Checked here too, so an oversized file reports why instead of spending a
  // slow upload on a request the route will refuse.
  if (file.size > MAX_CUSTOM_SOUND_BYTES) {
    error.value = message('size')
    return
  }
  if (!customSoundExtension(file.name)) {
    error.value = message('type')
    return
  }
  try {
    await store.uploadSound(file)
  } catch (failure) {
    error.value = describe(failure)
  }
}

async function remove(id: string) {
  error.value = ''
  try {
    await store.removeSound(id)
  } catch (failure) {
    error.value = describe(failure)
  }
}

function preview(reference: string) {
  playNotificationSound(reference, 1)
}

onMounted(() => {
  if (!store.loaded) void store.fetchSounds()
})
</script>
