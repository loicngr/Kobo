<template>
  <span v-if="text" class="text-kobo-3 text-no-wrap">{{ prefix }}{{ text }}</span>
</template>

<script setup lang="ts">
import { useTickingNow } from 'src/composables/use-ticking-now'
import { ciSpanMs, formatCiDuration, isCiRunning } from 'src/utils/ci-duration'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

type Timed = Parameters<typeof isCiRunning>[0]

// The only reader of the shared clock: a tick re-renders just these tiny spans.
const props = withDefaults(
  defineProps<{ item?: Timed; items?: readonly Timed[]; total?: boolean; live?: boolean; prefix?: string }>(),
  { live: true, prefix: '' },
)
const { t } = useI18n()
const list = computed(() => {
  const all = props.items ?? (props.item ? [props.item] : [])
  // When not live (closed PR, completed job) a running item has an unknown end: it shows nothing.
  return props.live ? all : all.filter((item) => !isCiRunning(item))
})
const running = computed(() => props.live && list.value.some((item) => isCiRunning(item)))
const now = useTickingNow(() => running.value)
const text = computed(() => {
  // Finished items never read the clock, so they never re-render on a tick.
  const ms = ciSpanMs(list.value, running.value ? now.value : 0)
  if (ms === null) return null
  const duration = formatCiDuration(ms, t)
  return props.total ? t('ciDuration.total', { duration }) : duration
})
</script>
