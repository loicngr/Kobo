<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { MemoryOperation } from '../../../../shared/memory'

withDefaults(defineProps<{ operations: MemoryOperation[]; hasMore?: boolean; loading?: boolean }>(), {
  hasMore: false,
  loading: false,
})
const emit = defineEmits<{ loadMore: [] }>()
const { t } = useI18n()

function actorLabel(operation: MemoryOperation): string {
  if (operation.actor.kind === 'external-mcp')
    return t('memory.operation.externalActor', {
      name: operation.actor.clientName,
      transport: operation.actor.transport,
    })
  if (operation.actor.kind === 'internal-agent')
    return t('memory.operation.internalActor', { engine: operation.actor.engine })
  return t('memory.operation.humanActor')
}
</script>

<template>
  <div class="memory-operations-list">
    <p v-if="operations.length === 0" class="memory-empty">{{ t('memory.operation.empty') }}</p>
    <ol>
      <li v-for="operation in operations" :key="operation.id">
        <span>{{ t(`memory.operation.${operation.kind}`) }}</span>
        <span>{{ actorLabel(operation) }}</span>
        <time :datetime="operation.createdAt">{{ operation.createdAt }}</time>
      </li>
    </ol>
    <button v-if="hasMore" type="button" :disabled="loading" @click="emit('loadMore')">
      {{ loading ? t('memory.operation.loading') : t('memory.operation.loadMore') }}
    </button>
  </div>
</template>

<style scoped>
.memory-operations-list ol { display: grid; gap: var(--kobo-space-sm); margin: 0; padding-inline-start: var(--kobo-space-2xl); }
.memory-operations-list li { display: flex; flex-wrap: wrap; gap: var(--kobo-space-md); align-items: baseline; }
.memory-operations-list time, .memory-empty { color: var(--kobo-text-2); font-size: 0.875rem; }
</style>
