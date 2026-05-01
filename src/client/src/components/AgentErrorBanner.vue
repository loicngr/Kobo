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
import { useAgentStreamStore } from 'src/stores/agent-stream'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ workspaceId: string }>()
const { t } = useI18n()
const stream = useAgentStreamStore()

async function dismiss(): Promise<void> {
  const eventId = lastErrorId.value
  if (!eventId) return
  // Optimistic: hide locally, then persist. On failure the banner reappears
  // after F5 — user can dismiss again.
  stream.removeByEventId(props.workspaceId, eventId)
  try {
    await fetch(`/api/workspaces/${props.workspaceId}/events/${eventId}`, { method: 'DELETE' })
  } catch (err) {
    console.warn('[agent-error-banner] failed to persist dismiss:', err)
  }
}

// Suppress informational "Warning:" stderr lines from the Claude CLI (the
// legacy pipeline persisted them as error events). Real engine errors
// (spawn_failed, etc.) don't start with "Warning:".
function isBenignWarning(message: string): boolean {
  // Strip ANSI escape sequences like "\u001b[33m" before matching "Warning:".
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes by design
  const cleaned = message.replace(/\u001b\[\d+m/g, '').trim()
  return /^warning:/i.test(cleaned)
}

const lastError = computed(() => {
  const events = stream.eventsFor(props.workspaceId)
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev.kind !== 'error' || ev.category === 'quota') continue
    if (ev.category === 'other' && isBenignWarning(ev.message)) continue
    return ev
  }
  return null
})

const lastErrorId = computed(() => {
  const events = stream.eventsFor(props.workspaceId)
  const ids = stream.eventIdsFor(props.workspaceId)
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev.kind !== 'error' || ev.category === 'quota') continue
    if (ev.category === 'other' && isBenignWarning(ev.message)) continue
    return ids[i] ?? null
  }
  return null
})

const visibleError = lastError
</script>
