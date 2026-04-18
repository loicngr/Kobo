<script setup lang="ts">
import type { ConversationItem } from 'src/services/agent-event-view'
import { computed } from 'vue'

const props = defineProps<{ item: Extract<ConversationItem, { type: 'session' }> }>()

const i18nKey = computed(() => {
  switch (props.item.kind) {
    case 'started':
      return 'session.started'
    case 'ended':
      return 'session.ended'
    case 'compacted':
      return 'session.compacted'
    default:
      return 'session.started'
  }
})
</script>

<template>
  <span class="text-caption text-grey-6">{{ $t(i18nKey) }}</span>
</template>
