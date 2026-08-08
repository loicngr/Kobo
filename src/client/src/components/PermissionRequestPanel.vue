<template>
  <div v-if="pending" class="permission-request-panel q-pa-sm bg-dark text-grey-3" :class="{ collapsed }">
    <div class="row items-center q-mb-sm">
      <q-icon name="security" size="16px" color="amber-4" class="q-mr-sm" />
      <div class="text-caption text-uppercase text-weight-bold text-amber-4" style="letter-spacing: 0.05em;">
        {{ t('permissionRequest.title') }}
      </div>
      <q-space />
      <q-btn
        :icon="collapsed ? 'expand_more' : 'expand_less'"
        flat
        dense
        size="sm"
        color="grey-4"
        :aria-label="t(collapsed ? 'permissionRequest.expand' : 'permissionRequest.collapse')"
        @click="collapsed = !collapsed"
      >
        <q-tooltip>{{ t(collapsed ? 'permissionRequest.expand' : 'permissionRequest.collapse') }}</q-tooltip>
      </q-btn>
    </div>

    <div v-show="!collapsed" class="text-body2 text-grey-2 q-mb-xs">
      <span class="text-weight-medium">{{ t('permissionRequest.tool') }}:</span>
      <code class="q-ml-xs">{{ pending.toolName }}</code>
    </div>
    <template v-if="!collapsed">
    <div class="text-caption text-grey-6 q-mb-xs">{{ t('permissionRequest.input') }}</div>
    <template v-if="fileWritePreview">
      <div class="permission-file-path"><q-icon name="description" size="15px" class="q-mr-xs" />{{ fileWritePreview.path }}</div>
      <pre class="permission-input-pre">{{ fileWritePreview.content }}</pre>
      <q-expansion-item dense :label="t('permissionRequest.rawInput')" header-class="text-caption text-grey-6">
        <pre class="permission-input-pre q-mt-xs">{{ formattedInput }}</pre>
      </q-expansion-item>
    </template>
    <pre v-else class="permission-input-pre">{{ formattedInput }}</pre>
    </template>

    <div v-show="!collapsed" class="row items-center q-gutter-sm q-mt-sm">
      <q-btn
        :label="t('permissionRequest.allowOnce')"
        color="indigo-5"
        dense
        unelevated
        :loading="submitting"
        :disable="submitting"
        @click="decide('allow', 'once')"
      />
      <q-btn flat dense :label="t('permissionRequest.allowTurn')" :disable="submitting" @click="decide('allow', 'turn')" />
      <q-btn flat dense :label="t('permissionRequest.allowOperation')" :disable="submitting" @click="decide('allow', 'operation')" />
      <q-btn flat dense :label="t('permissionRequest.allowTool')" :disable="submitting" @click="decide('allow', 'tool')" />
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
  if (head?.kind !== 'permission') return undefined
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

const fileWritePreview = computed<{ path: string; content: string } | null>(() => {
  if (pending.value?.toolName !== 'Write') return null
  const input = pending.value.toolInput
  if (!input || typeof input !== 'object') return null
  const record = input as { file_path?: unknown; content?: unknown }
  if (typeof record.file_path !== 'string' || typeof record.content !== 'string') return null
  return { path: record.file_path, content: record.content }
})

const submitting = ref(false)
const error = ref<string | null>(null)
const collapsed = ref(false)

watch(
  () => pending.value?.toolCallId ?? null,
  () => {
    submitting.value = false
    error.value = null
    collapsed.value = false
  },
)

async function decide(
  decision: 'allow' | 'deny',
  scope: 'once' | 'turn' | 'operation' | 'tool' = 'once',
): Promise<void> {
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
      scope,
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
.permission-request-panel.collapsed .row {
  margin-bottom: 0;
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
.permission-file-path {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 12px;
  color: #b6c4ff;
  margin-bottom: 0.4em;
  word-break: break-all;
}
</style>
