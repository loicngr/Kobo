<template>
  <q-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)">
    <q-card dark style="min-width: 360px;">
      <q-card-section>
        <div class="text-subtitle1">{{ $t('tags.manageTitle') }}</div>
        <div class="text-caption text-grey-6 q-mt-xs">{{ workspace.name }}</div>
      </q-card-section>
      <q-card-section>
        <q-option-group
          v-if="availableTags.length > 0"
          v-model="selected"
          :options="availableTags.map((tag) => ({
            label: orphanedTags.includes(tag) ? `${tag}` : tag,
            value: tag,
          }))"
          type="checkbox"
          dense
          dark
        />
        <div v-if="orphanedTags.length > 0" class="text-caption text-orange-5 q-mt-sm">
          {{ $t('tags.orphanedHint', { count: orphanedTags.length }) }}
        </div>
        <div v-if="availableTags.length === 0" class="text-grey-6 text-caption">
          {{ $t('tags.noTagsDefined') }}
        </div>
      </q-card-section>
      <q-card-actions align="right">
        <q-btn flat :label="$t('common.cancel')" @click="close" />
        <q-btn color="primary" :label="$t('common.save')" :loading="saving" @click="save" />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { useQuasar } from 'quasar'
import { useSettingsStore } from 'src/stores/settings'
import { useWorkspaceStore, type Workspace } from 'src/stores/workspace'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  modelValue: boolean
  workspace: Workspace
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const { t } = useI18n()
const settingsStore = useSettingsStore()
const workspaceStore = useWorkspaceStore()
const $q = useQuasar()

const selected = ref<string[]>([])
const saving = ref(false)

watch(
  () => props.modelValue,
  (open) => {
    if (open) selected.value = [...props.workspace.tags]
  },
  { immediate: true },
)

// Union of the global catalog plus any tags already assigned to this workspace,
// so orphaned tags (removed from the catalog after being assigned) remain visible
// and the user can uncheck them.
const availableTags = computed<string[]>(() => {
  const catalog = settingsStore.global.tags ?? []
  const assigned = props.workspace.tags ?? []
  return Array.from(new Set([...catalog, ...assigned]))
})

const orphanedTags = computed<string[]>(() => {
  const catalog = new Set(settingsStore.global.tags ?? [])
  return (props.workspace.tags ?? []).filter((t) => !catalog.has(t))
})

async function save() {
  saving.value = true
  try {
    await workspaceStore.setWorkspaceTags(props.workspace.id, selected.value)
    emit('update:modelValue', false)
  } catch (err) {
    $q.notify({ type: 'negative', message: String(err), position: 'top', timeout: 4000 })
  } finally {
    saving.value = false
  }
}

function close() {
  emit('update:modelValue', false)
}
</script>
