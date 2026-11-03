<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  DEFAULT_MEMORY_LIMITS,
  MEMORY_LIMIT_RANGES,
  type MemoryLimits,
  resolveMemoryLimits,
} from '../../../../shared/memory-limits'

const props = defineProps<{ modelValue: MemoryLimits }>()
const emit = defineEmits<{ 'update:modelValue': [value: MemoryLimits] }>()
const { t } = useI18n()
const fields = Object.keys(DEFAULT_MEMORY_LIMITS) as (keyof MemoryLimits)[]
const invalid = computed(() => {
  try {
    resolveMemoryLimits(props.modelValue)
    return false
  } catch {
    return true
  }
})
function update(key: keyof MemoryLimits, event: Event) {
  emit('update:modelValue', { ...props.modelValue, [key]: (event.target as HTMLInputElement).valueAsNumber })
}
</script>

<template>
  <section class="memory-limits" aria-labelledby="memory-limits-title">
    <h4 id="memory-limits-title">{{ t('memory.limits.title') }}</h4>
    <p class="text-caption text-kobo-3">{{ t('memory.limits.hint') }}</p>
    <div class="memory-limits__fields">
      <label v-for="key in fields" :key="key">
        <span>{{ t(`memory.limits.${key}`) }}</span>
        <input
          :value="modelValue[key]"
          :name="key"
          type="number"
          :min="MEMORY_LIMIT_RANGES[key][0]"
          :max="MEMORY_LIMIT_RANGES[key][1]"
          step="1"
          required
          @input="update(key, $event)"
        />
      </label>
    </div>
    <p v-if="invalid" class="text-negative" role="alert">{{ t('memory.limits.invalid') }}</p>
    <q-btn
      flat
      no-caps
      icon="restart_alt"
      :label="t('memory.limits.reset')"
      @click="emit('update:modelValue', { ...DEFAULT_MEMORY_LIMITS })"
    />
  </section>
</template>

<style scoped>
.memory-limits {
  min-width: 0;
  display: grid;
  gap: var(--kobo-space-md);
}
.memory-limits h4 { margin: 0; font-size: 1rem; line-height: 1.5; font-weight: 600; }
.memory-limits p { margin: 0; }
.memory-limits .q-btn { justify-self: start; }
.memory-limits__fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
  gap: 16px;
}
.memory-limits label {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.memory-limits input {
  font: inherit;
  color: inherit;
  background: transparent;
  border: 1px solid var(--kobo-border-subtle);
  border-radius: 4px;
  padding: 8px;
  width: 100%;
}
.memory-limits input:focus-visible {
  outline: 2px solid var(--q-primary);
  outline-offset: 2px;
}
</style>
