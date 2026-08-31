<template>
  <span class="text-caption text-kobo-3">{{ $t(i18nKey) }}</span>
</template>

<script setup lang="ts">
import { type ConversationItem, sessionEndedI18nKey } from 'src/services/agent-event-view'
import { computed } from 'vue'

const props = defineProps<{ item: Extract<ConversationItem, { type: 'session' }> }>()

const i18nKey = computed(() => {
  switch (props.item.kind) {
    case 'started':
      return 'session.started'
    case 'ended':
      // The reason has always been carried in `detail`; reading it is what
      // separates "the turn is over, keep typing" from "it crashed".
      return sessionEndedI18nKey(props.item.detail)
    case 'compacted':
      return 'session.compacted'
    default:
      return 'session.started'
  }
})
</script>
