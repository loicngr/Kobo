<script setup lang="ts">
import type { MemoryScopeRecord } from 'src/stores/memory'
import { useI18n } from 'vue-i18n'

defineProps<{ scopes: MemoryScopeRecord[]; modelValue: string }>()
const emit = defineEmits<{ 'update:modelValue': [scopeId: string] }>()
const { t } = useI18n()

function scopeLabel(scope: MemoryScopeRecord): string {
  const level = t(`memory.scope.${scope.level}`)
  if (scope.level === 'project') return `${level} · ${scope.projectPath ?? scope.id}`
  if (scope.level === 'workspace') return `${level} · ${scope.workspaceId ?? scope.id}`
  return level
}
</script>

<template>
  <label class="memory-scope-select">
    <span>{{ t('memory.scope.label') }}</span>
    <select :value="modelValue" @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)">
      <option value="">{{ t('memory.scope.choose') }}</option>
      <option v-for="scope in scopes" :key="scope.id" :value="scope.id">{{ scopeLabel(scope) }}</option>
    </select>
  </label>
</template>

<style scoped>
.memory-scope-select { display: grid; gap: var(--kobo-space-sm); }
select { min-height: 40px; padding: 0 var(--kobo-space-md); color: var(--kobo-text); background: var(--kobo-surface); border: 1px solid var(--kobo-border-subtle); border-radius: var(--kobo-radius-sm); }
</style>
