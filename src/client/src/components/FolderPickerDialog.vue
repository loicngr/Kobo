<template>
  <q-dialog
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <q-card class="text-grey-3" style="min-width: 480px; max-width: 90vw; background: #1e1e3a;">
      <q-card-section class="row items-center q-pb-none">
        <div class="text-h6">{{ $t('folderPicker.title') }}</div>
        <q-space />
        <q-btn v-close-popup flat dense round icon="close" color="grey-5" />
      </q-card-section>

      <q-card-section>
        <div
          class="text-caption text-grey-6 ellipsis q-mb-sm"
          style="font-family: monospace;"
          :title="currentPath"
        >
          {{ currentPath || '…' }}
        </div>

        <q-banner v-if="error" dense class="bg-red-9 text-white q-mb-sm rounded-borders">
          {{ error }}
        </q-banner>

        <q-list bordered separator class="rounded-borders" style="max-height: 320px; overflow-y: auto;">
          <q-item v-if="parent" v-ripple clickable @click="navigate(parent)">
            <q-item-section avatar>
              <q-icon name="arrow_upward" color="grey-5" />
            </q-item-section>
            <q-item-section>{{ $t('folderPicker.parent') }}</q-item-section>
          </q-item>
          <q-item
            v-for="entry in entries"
            :key="entry.path"
            v-ripple
            clickable
            @click="navigate(entry.path)"
          >
            <q-item-section avatar>
              <q-icon name="folder" color="amber-6" />
            </q-item-section>
            <q-item-section>{{ entry.name }}</q-item-section>
          </q-item>
          <q-item v-if="!loading && entries.length === 0">
            <q-item-section class="text-grey-7">{{ $t('folderPicker.empty') }}</q-item-section>
          </q-item>
        </q-list>

        <div v-if="loading" class="row justify-center q-mt-sm">
          <q-spinner size="20px" color="grey-5" />
        </div>
      </q-card-section>

      <q-card-actions align="right">
        <q-btn v-close-popup flat :label="$t('common.cancel')" color="grey-5" />
        <q-btn
          flat
          :label="$t('folderPicker.select')"
          color="primary"
          :disable="!currentPath || loading"
          @click="choose"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{ modelValue: boolean; initialPath?: string }>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  select: [path: string]
}>()

interface DirEntry {
  name: string
  path: string
}

const currentPath = ref('')
const parent = ref<string | null>(null)
const entries = ref<DirEntry[]>([])
const loading = ref(false)
const error = ref('')

// Fetch and display the subdirectories of `target` (home dir when omitted).
async function navigate(target?: string) {
  loading.value = true
  error.value = ''
  try {
    const qs = target ? `?path=${encodeURIComponent(target)}` : ''
    const res = await fetch(`/api/fs/list-dirs${qs}`)
    const body = (await res.json()) as {
      path?: string
      parent?: string | null
      entries?: DirEntry[]
      error?: string
    }
    if (!res.ok) {
      error.value = body?.error ?? `HTTP ${res.status}`
      return
    }
    currentPath.value = body.path ?? ''
    parent.value = body.parent ?? null
    entries.value = Array.isArray(body.entries) ? body.entries : []
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

function choose() {
  if (!currentPath.value) return
  emit('select', currentPath.value)
  emit('update:modelValue', false)
}

// Reload the listing each time the dialog opens.
watch(
  () => props.modelValue,
  (open) => {
    if (open) void navigate(props.initialPath || undefined)
  },
)
</script>
