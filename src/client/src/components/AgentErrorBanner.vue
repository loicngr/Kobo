<template>
  <q-banner v-if="lastError" class="bg-negative text-white q-ma-sm">
    <template #avatar><q-icon name="error_outline" /></template>
    <div class="text-subtitle2">{{ t(`agent.error.${lastError.category}`) }}</div>
    <div class="text-caption">{{ lastError.message }}</div>
  </q-banner>
</template>

<script setup lang="ts">
import { useAgentStreamStore } from 'src/stores/agent-stream'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ workspaceId: string }>()
const { t } = useI18n()
const stream = useAgentStreamStore()

// Heuristic: Claude CLI prints informational "Warning:" lines to stderr that
// the legacy pipeline persisted as error events. Those are not actionable for
// the user — suppress them. A legitimate engine error (spawn_failed, etc.)
// will not start with "Warning:".
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
</script>
