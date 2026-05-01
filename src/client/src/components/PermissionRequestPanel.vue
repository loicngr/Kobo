<template>
  <div v-if="pending" class="permission-request-panel q-pa-sm bg-dark text-grey-3">
    <div class="row items-center q-mb-sm">
      <q-icon name="security" size="16px" color="amber-4" class="q-mr-sm" />
      <div class="text-caption text-uppercase text-weight-bold text-amber-4" style="letter-spacing: 0.05em;">
        {{ t('permissionRequest.title') }}
      </div>
    </div>

    <div class="text-body2 text-grey-2 q-mb-xs">
      <span class="text-weight-medium">{{ t('permissionRequest.tool') }}:</span>
      <code class="q-ml-xs">{{ pending.toolName }}</code>
    </div>
    <div class="text-caption text-grey-6 q-mb-xs">{{ t('permissionRequest.input') }}</div>
    <pre class="permission-input-pre">{{ formattedInput }}</pre>

    <div class="row items-center q-gutter-sm q-mt-sm">
      <q-btn
        :label="t('permissionRequest.allow')"
        color="indigo-5"
        dense
        unelevated
        :loading="submitting"
        :disable="submitting"
        @click="decide('allow')"
      />
      <q-btn
        :label="t('permissionRequest.deny')"
        flat
        dense
        color="grey-4"
        :disable="submitting"
        @click="decide('deny')"
      />
      <q-space />
      <span v-if="error" class="text-negative text-caption">{{ error }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useWorkspaceStore } from 'src/stores/workspace'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ workspaceId: string }>()
const { t } = useI18n()
const store = useWorkspaceStore()

const pending = computed(() => {
  const head = store.peekPending(props.workspaceId)
  if (!head || head.kind !== 'permission') return undefined
  return head
})

const formattedInput = computed(() => {
  if (!pending.value) return ''
  try {
    return JSON.stringify(pending.value.toolInput, null, 2)
  } catch {
    return String(pending.value.toolInput)
  }
})

const submitting = ref(false)
const error = ref<string | null>(null)

watch(
  () => pending.value?.toolCallId ?? null,
  () => {
    submitting.value = false
    error.value = null
  },
)

async function decide(decision: 'allow' | 'deny'): Promise<void> {
  if (!pending.value) return
  if (submitting.value) return
  submitting.value = true
  error.value = null
  try {
    await store.submitDeferredPermission(
      props.workspaceId,
      pending.value.toolCallId,
      decision,
      decision === 'deny' ? t('permissionRequest.denied') : undefined,
    )
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.permission-request-panel {
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.permission-input-pre {
  background: rgba(0, 0, 0, 0.35);
  padding: 0.5em 0.75em;
  border-radius: 4px;
  font-size: 12px;
  max-height: 30vh;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}
</style>
