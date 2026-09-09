<template>
  <q-banner v-if="visibleError" class="bg-negative text-white q-ma-sm">
    <template #avatar><q-icon name="error_outline" /></template>
    <div class="text-subtitle2">{{ t(`agent.error.${visibleError.category}`) }}</div>
    <div class="text-caption">{{ visibleError.message }}</div>
    <template #action>
      <q-btn
        flat
        dense
        round
        icon="close"
        :aria-label="t('common.close')"
        @click="dismiss"
      >
        <q-tooltip>{{ t('common.close') }}</q-tooltip>
      </q-btn>
    </template>
  </q-banner>
</template>

<script setup lang="ts">
import { selectLastAgentError } from 'src/services/agent-event-view'
import { useAgentStreamStore } from 'src/stores/agent-stream'
import { errorDismissalKey, readDismissedAgentErrors, saveDismissedAgentError } from 'src/utils/dismissed-agent-errors'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ workspaceId: string }>()
const { t } = useI18n()
const stream = useAgentStreamStore()

// Persist only event IDs: F5 can replay history without resurrecting dismissed banners.
const dismissedEventIds = ref<Set<string>>(new Set())
watch(
  () => props.workspaceId,
  (id) => {
    dismissedEventIds.value = readDismissedAgentErrors(id)
  },
  { immediate: true },
)
function onStorage(event: StorageEvent) {
  if (event.key === errorDismissalKey(props.workspaceId)) {
    dismissedEventIds.value = new Set([...dismissedEventIds.value, ...readDismissedAgentErrors(props.workspaceId)])
  }
}
onMounted(() => window.addEventListener('storage', onStorage))
onUnmounted(() => window.removeEventListener('storage', onStorage))
function dismiss(): void {
  const eventId = selected.value?.eventId
  if (eventId) dismissedEventIds.value = saveDismissedAgentError(props.workspaceId, eventId, dismissedEventIds.value)
}

const selected = computed(() =>
  selectLastAgentError(
    stream.eventsFor(props.workspaceId),
    stream.eventIdsFor(props.workspaceId),
    dismissedEventIds.value,
  ),
)

const visibleError = computed(() => selected.value?.event ?? null)
</script>
