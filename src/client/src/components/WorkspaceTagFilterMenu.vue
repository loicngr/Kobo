<template>
  <q-btn
    flat
    dense
    round
    size="sm"
    icon="sell"
    :color="props.modelValue.length > 0 ? 'primary' : 'kobo-3'"
    :aria-label="label"
    :aria-pressed="props.modelValue.length > 0"
    aria-haspopup="menu"
  >
    <q-badge v-if="props.modelValue.length > 0" floating rounded color="primary" data-tag-filter-count>{{ props.modelValue.length }}</q-badge>
    <q-tooltip>{{ label }}</q-tooltip>
    <q-menu anchor="bottom right" self="top right">
      <q-list dense style="min-width: 220px" role="menu">
        <q-item-label header>{{ $t('workspace.tagFilter') }}</q-item-label>
        <q-item-label v-if="props.tags.length === 0" caption class="q-pa-md" style="max-width: 260px">
          {{ $t('workspace.tagFilterEmpty') }}
        </q-item-label>
        <q-item
          v-for="entry in props.tags"
          :key="entry.tag"
          clickable
          role="menuitemcheckbox"
          :aria-checked="props.modelValue.includes(entry.tag)"
          :data-tag="entry.tag"
          @click="toggle(entry.tag)"
        >
          <q-item-section side>
            <!-- QCheckbox stops its own click, so the row's @click never sees it. -->
            <q-checkbox :model-value="props.modelValue.includes(entry.tag)" dense size="xs" tabindex="-1" @update:model-value="toggle(entry.tag)" />
          </q-item-section>
          <q-item-section>{{ entry.tag }}</q-item-section>
          <q-item-section side class="text-kobo-3">{{ entry.count }}</q-item-section>
        </q-item>
        <template v-if="props.modelValue.length > 0">
          <q-separator />
          <q-item clickable data-tag-filter-clear @click="emit('update:modelValue', [])">
            <q-item-section>{{ $t('workspace.tagFilterClear') }}</q-item-section>
          </q-item>
        </template>
      </q-list>
    </q-menu>
  </q-btn>
</template>

<script setup lang="ts">
import type { TagCount } from 'src/utils/workspace-tag-filter'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ modelValue: string[]; tags: TagCount[] }>()
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()
const { t } = useI18n()
const label = computed(() =>
  props.modelValue.length > 0
    ? t('workspace.tagFilterActive', { count: props.modelValue.length })
    : t('workspace.tagFilter'),
)
function toggle(tag: string) {
  emit(
    'update:modelValue',
    props.modelValue.includes(tag)
      ? props.modelValue.filter((selected) => selected !== tag)
      : [...props.modelValue, tag],
  )
}
</script>
