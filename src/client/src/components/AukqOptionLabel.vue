<template>
  <span class="text-grey-3">
    {{ isOther ? t('askUserQuestion.otherOption') : label }}
  </span>
  <span v-if="isOther" class="text-grey-6 q-ml-xs">— {{ t('askUserQuestion.otherOptionHint') }}</span>
  <span v-else-if="description" class="text-grey-6 q-ml-xs">— {{ description }}</span>
</template>

<script setup lang="ts">
import { OTHER_OPTION_VALUE } from 'src/utils/expand-other-answer'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ label: string; description?: string }>()
const { t } = useI18n()

const isOther = computed(() => props.label === OTHER_OPTION_VALUE)
</script>
