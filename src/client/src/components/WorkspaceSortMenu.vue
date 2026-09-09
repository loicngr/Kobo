<template>
  <q-btn flat dense round size="sm" color="kobo-3" :aria-label="$t('workspaceSort.label')"
    aria-haspopup="menu" :aria-expanded="open" data-tour="workspace-sort">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <path d="M3 6h18M3 12h12M3 18h6" />
    </svg>
    <q-tooltip>{{ $t('workspaceSort.label') }} · {{ $t(`workspaceSort.${model.field}`) }} · {{ $t(`workspaceSort.${model.direction}`) }}</q-tooltip>
    <q-menu v-model="open" anchor="bottom right" self="top right">
      <q-list dense style="min-width: 230px" role="menu">
        <q-item-label header>{{ $t('workspaceSort.label') }}</q-item-label>
        <q-item v-for="field in WORKSPACE_SORT_FIELDS" :key="field" clickable role="menuitemradio"
          :aria-checked="model.field === field" @click="selectField(field)">
          <q-item-section>{{ $t(`workspaceSort.${field}`) }}</q-item-section>
          <q-item-section side v-if="model.field === field"><q-icon name="check" size="xs" /></q-item-section>
        </q-item>
        <q-separator />
        <q-item v-for="direction in directions" :key="direction" clickable role="menuitemradio"
          :aria-checked="model.direction === direction" @click="model = { ...model, direction }">
          <q-item-section>{{ $t(`workspaceSort.${direction}`) }}</q-item-section>
          <q-item-section side v-if="model.direction === direction"><q-icon name="check" size="xs" /></q-item-section>
        </q-item>
        <q-item-label caption class="q-pa-md" style="max-width: 260px">{{ $t('workspaceSort.hint') }}</q-item-label>
      </q-list>
    </q-menu>
  </q-btn>
</template>

<script setup lang="ts">
import { WORKSPACE_SORT_FIELDS, type WorkspaceSort, type WorkspaceSortField } from 'src/utils/workspace-sort'
import { ref } from 'vue'

const model = defineModel<WorkspaceSort>({ required: true })
const open = ref(false)
const directions = ['asc', 'desc'] as const
function selectField(field: WorkspaceSortField) {
  model.value = { field, direction: field === 'name' ? 'asc' : 'desc' }
}
</script>
