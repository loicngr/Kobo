<template>
  <div class="slash-suggestions rounded-borders">
    <!-- Claude skills -->
    <template v-if="groupedDropdown.skills.length > 0">
      <div class="slash-section-header">{{ t('chatInput.dropdownSkills') }}</div>
      <div
        v-for="item in groupedDropdown.skills"
        :key="`skill-${item.name}`"
        class="slash-item row items-center q-px-sm q-py-xs cursor-pointer"
        :class="{ 'slash-item--active': flatDropdown.indexOf(item) === selectedIndex }"
        @mousedown.prevent="emit('select', item)"
      >
        <q-icon name="bolt" size="12px" color="indigo-4" class="q-mr-xs" />
        <span class="slash-name text-caption">{{ item.name }}</span>
      </div>
    </template>

    <!-- Kōbō commands -->
    <template v-if="groupedDropdown.kobo.length > 0">
      <div class="slash-section-header">{{ t('chatInput.dropdownKobo') }}</div>
      <div
        v-for="item in groupedDropdown.kobo"
        :key="`kobo-${item.name}`"
        class="slash-item row items-center q-px-sm q-py-xs cursor-pointer"
        :class="{ 'slash-item--active': flatDropdown.indexOf(item) === selectedIndex }"
        @mousedown.prevent="emit('select', item)"
      >
        <q-icon name="terminal" size="12px" color="teal-4" class="q-mr-xs" />
        <span class="slash-name text-caption">/{{ item.name }}</span>
        <span
          v-if="koboDescription(item.name)"
          class="slash-description text-caption text-grey-7 q-ml-xs"
        >— {{ koboDescription(item.name) }}</span>
      </div>
    </template>

    <!-- User templates -->
    <template v-if="groupedDropdown.templates.length > 0">
      <div class="slash-section-header">{{ t('chatInput.dropdownTemplates') }}</div>
      <div
        v-for="item in groupedDropdown.templates"
        :key="`tpl-${item.name}`"
        class="slash-item row items-center q-px-sm q-py-xs cursor-pointer"
        :class="{ 'slash-item--active': flatDropdown.indexOf(item) === selectedIndex }"
        @mousedown.prevent="emit('select', item)"
      >
        <q-icon name="description" size="12px" color="amber-4" class="q-mr-xs" />
        <span class="slash-name text-caption">/{{ item.name }}</span>
        <span
          v-if="item.description"
          class="slash-description text-caption text-grey-7 q-ml-xs"
        >— {{ item.description }}</span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { SlashDropdownItem } from 'src/composables/use-slash-autocomplete'
import { KOBO_COMMANDS } from 'src/utils/kobo-commands'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

defineProps<{
  /** Sections to render. Section keys: skills | kobo | templates. */
  groupedDropdown: {
    skills: SlashDropdownItem[]
    kobo: SlashDropdownItem[]
    templates: SlashDropdownItem[]
  }
  /** Concatenated list — used to compute the active row index. */
  flatDropdown: SlashDropdownItem[]
  /** Index of the currently highlighted row (keyboard nav). */
  selectedIndex: number
}>()

const emit = defineEmits<{ select: [item: SlashDropdownItem] }>()

function koboDescription(slug: string): string {
  const entry = KOBO_COMMANDS[`/${slug}`]
  if (!entry) return ''
  // KOBO_COMMANDS values include a description key into i18n; fall back to the
  // raw key if i18n is missing the entry (defensive — shouldn't happen).
  const key = entry.descriptionKey
  const translated = t(key)
  return translated === key ? '' : translated
}
</script>

<style lang="scss" scoped>
.slash-suggestions {
  max-height: 300px;
  overflow-y: auto;
  background-color: #1e1e3a;
  border: 1px solid #2a2a4a;
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.4);
}
.slash-section-header {
  padding: 4px 12px;
  font-size: 10px;
  text-transform: uppercase;
  color: #6b7280;
  letter-spacing: 0.05em;
  border-top: 1px solid rgba(255, 255, 255, 0.05);

  &:first-child {
    border-top: none;
  }
}
.slash-item {
  font-family: 'Roboto Mono', monospace;

  &:hover,
  &--active {
    background-color: rgba(108, 99, 255, 0.15);
  }
}
</style>
