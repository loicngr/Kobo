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
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ workspaceId: string }>()
const { t } = useI18n()
const stream = useAgentStreamStore()

// Acknowledged (dismissed) event ids — client-local, in-memory only.
// Deliberately NOT persisted and NEVER sent to the server: the feed now
// anchors this same event in the conversation timeline (task 9), so
// destroying it on dismiss (the old behaviour) erased that anchor too, plus
// any future diagnostic query over it. A reload legitimately brings a
// dismissed-but-undeleted error back — that's the accepted trade-off for
// this iteration, preferred over silent, permanent data loss.
const dismissedEventIds = ref<Set<string>>(new Set())

function dismiss(): void {
  const eventId = selected.value?.eventId
  if (!eventId) return
  const next = new Set(dismissedEventIds.value)
  next.add(eventId)
  dismissedEventIds.value = next
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
