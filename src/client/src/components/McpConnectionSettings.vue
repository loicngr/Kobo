<template>
  <section data-tour="settings-mcp" class="q-mt-lg">
    <div class="text-subtitle2 q-mb-sm">{{ t('settings.mcp.title') }}</div>
    <p class="text-caption text-kobo-3">{{ t('settings.mcp.hint') }}</p>
    <q-banner v-if="loadFailed" dense class="bg-negative text-white">{{ t('settings.network.loadFailed') }}</q-banner>
    <template v-else-if="info">
      <p v-if="!networkEnabled" class="text-caption text-kobo-3">{{ t('settings.mcp.remoteDisabled') }}</p>
      <q-banner dense class="q-mb-md">{{ t('settings.mcp.scopedHint') }}</q-banner>
      <q-input v-model="keyName" :label="t('settings.mcp.keyName')" maxlength="120" outlined dense class="q-mb-sm" />
      <q-toggle v-model="allWorkspaces" :label="t('settings.mcp.allWorkspaces')" />
      <q-select v-if="!allWorkspaces" v-model="workspaceIds" :options="workspaceOptions" multiple emit-value map-options use-chips :label="t('settings.mcp.workspaces')" outlined dense class="q-mb-sm" />
      <q-select v-model="grantedTools" :options="toolOptions" multiple emit-value map-options use-chips :label="t('settings.mcp.tools')" outlined dense class="q-mb-sm" />
      <p class="text-caption text-kobo-3">{{ t('settings.mcp.scopeHint') }}</p>
      <q-select v-model="expiryDays" :options="expiryOptions" emit-value map-options :label="t('settings.mcp.expiry')" outlined dense class="q-mb-sm" />
      <q-btn outline no-caps :loading="saving" :disable="!keyName.trim() || (!allWorkspaces && !workspaceIds.length) || !grantedTools.length" :label="t('settings.mcp.createKey')" @click="createKey" />
      <q-banner v-if="createdToken" class="q-my-md">
        <p>{{ t('settings.mcp.oneTimeKey') }}</p>
        <q-input :model-value="createdToken" readonly outlined dense :label="t('settings.mcp.key')" />
        <q-btn flat no-caps icon="content_copy" :label="t('settings.mcp.copyKey')" @click="copy(createdToken)" />
        <q-btn flat no-caps :label="t('settings.mcp.hideKey')" @click="createdToken = ''" />
      </q-banner>
      <q-list bordered separator class="q-my-md">
        <q-item v-for="credential in credentials" :key="credential.id">
          <q-item-section>
            <q-item-label>{{ credential.name }}</q-item-label>
            <q-item-label caption>{{ credential.allWorkspaces ? t('settings.mcp.allWorkspaces') : credential.workspaceIds.join(', ') }}</q-item-label>
            <q-item-label caption>{{ credential.tools.join(', ') }}</q-item-label>
            <q-item-label caption>{{ credential.expiresAt ? new Date(credential.expiresAt).toLocaleString() : t('settings.mcp.noExpiry') }}</q-item-label>
          </q-item-section>
          <q-item-section side><q-btn flat no-caps color="negative" :disable="saving" :label="t('settings.mcp.revoke')" @click="revokeKey(credential.id)" /></q-item-section>
        </q-item>
      </q-list>
      <q-input v-model="clientName" :label="t('settings.mcp.clientName')" maxlength="120" outlined dense dark class="q-mb-md" />
      <q-select v-model="selectedUrl" :options="options" emit-value map-options :label="t('settings.mcp.connection')" outlined dense dark />
      <template v-if="selection">
        <div v-if="selection !== 'stdio'" class="row items-center q-mt-sm">
          <code class="mcp-url col">{{ selection.url }}</code>
          <q-btn flat dense icon="content_copy" :title="t('settings.mcp.copyUrl')" @click="copy(selection.url)" />
        </div>
        <pre class="mcp-config q-pa-sm">{{ preview }}</pre>
        <p class="text-caption text-kobo-3">{{ t('settings.mcp.genericFormat') }}</p>
        <div class="row q-gutter-sm">
          <q-btn outline dense no-caps icon="content_copy" :label="t('settings.mcp.copyConfig')" @click="copy(preview)" />
          <q-btn outline dense no-caps :disable="!createdToken" :label="t('settings.mcp.copyWithToken')" @click="copyWithToken" />
        </div>
        <p v-if="!createdToken" class="text-caption text-kobo-3 q-mt-sm">{{ t('settings.mcp.tokenUnavailable') }}</p>
      </template>
      <p v-if="!info.stdio" class="text-caption text-kobo-3 q-mt-sm">{{ t('settings.mcp.stdioUnavailable') }}</p>
    </template>
    <q-spinner v-else />
  </section>
</template>

<script setup lang="ts">
import { copyToClipboard, useQuasar } from 'quasar'
import { apiFetch } from 'src/utils/api'
import { formatMcpConfig, getMcpEndpoints, type McpConnectionInfo } from 'src/utils/mcp-connection-config'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ token?: string; networkEnabled: boolean; behindProxy: boolean }>()
const { t } = useI18n()
const $q = useQuasar()
const info = ref<McpConnectionInfo | null>(null)
const loadFailed = ref(false)
const clientName = ref('')
const selectedUrl = ref('')
const endpoints = computed(() => (info.value ? getMcpEndpoints(info.value, window.location.origin) : []))
const options = computed(() => [
  ...endpoints.value.map((endpoint) => ({
    label: `${t(`settings.mcp.${endpoint.kind}`)} — ${endpoint.url}`,
    value: endpoint.url,
  })),
  ...(info.value?.stdio ? [{ label: t('settings.mcp.stdio'), value: 'stdio' }] : []),
])
const selection = computed(() =>
  selectedUrl.value === 'stdio' && info.value?.stdio
    ? 'stdio'
    : endpoints.value.find((endpoint) => endpoint.url === selectedUrl.value),
)
const preview = computed(() =>
  info.value && selection.value ? formatMcpConfig(info.value, selection.value, clientName.value) : '',
)
interface Credential {
  id: string
  name: string
  tools: string[]
  allWorkspaces: boolean
  workspaceIds: string[]
  expiresAt: string | null
}
const credentials = ref<Credential[]>([])
const keyName = ref('')
const allWorkspaces = ref(false)
const workspaceIds = ref<string[]>([])
const workspaceOptions = ref<Array<{ label: string; value: string }>>([])
const toolOptions = ref<Array<{ label: string; value: string }>>([])
const grantedTools = ref<string[]>([])
const expiryDays = ref<number | null>(30)
const createdToken = ref('')
const saving = ref(false)
const expiryOptions = computed(() => [
  ...[7, 30, 90, 365].map((value) => ({ label: t('settings.mcp.expiryDays', { count: value }), value })),
  { label: t('settings.mcp.noExpiry'), value: null },
])
async function loadKeys(signal?: AbortSignal) {
  const result = await apiFetch<{ credentials: Credential[]; tools: Array<{ name: string; readOnly: boolean }> }>(
    '/api/mcp-credentials',
    { signal },
  )
  if (signal?.aborted) return
  credentials.value = result.credentials
  toolOptions.value = result.tools.map((tool) => ({
    label: `${tool.name} — ${t(tool.readOnly ? 'settings.mcp.readOnly' : 'settings.mcp.write')}`,
    value: tool.name,
  }))
  if (!grantedTools.value.length)
    grantedTools.value = result.tools.filter((tool) => tool.readOnly).map((tool) => tool.name)
}
async function createKey() {
  saving.value = true
  createdToken.value = ''
  try {
    const result = await apiFetch<{ token: string; credential: Credential }>('/api/mcp-credentials', {
      method: 'POST',
      body: {
        name: keyName.value,
        tools: grantedTools.value,
        allWorkspaces: allWorkspaces.value,
        workspaceIds: allWorkspaces.value ? [] : workspaceIds.value,
        expiresAt: expiryDays.value ? new Date(Date.now() + expiryDays.value * 86400000).toISOString() : null,
      },
    })
    createdToken.value = result.token
    credentials.value.push(result.credential)
  } catch (error) {
    $q.notify({ type: 'negative', message: error instanceof Error ? error.message : t('settings.mcp.failed') })
  } finally {
    saving.value = false
  }
}
async function revokeKey(id: string) {
  saving.value = true
  try {
    await apiFetch(`/api/mcp-credentials/${encodeURIComponent(id)}`, { method: 'DELETE' })
    credentials.value = credentials.value.filter((credential) => credential.id !== id)
    createdToken.value = ''
  } catch (error) {
    $q.notify({ type: 'negative', message: error instanceof Error ? error.message : t('settings.mcp.failed') })
  } finally {
    saving.value = false
  }
}

watch(
  () => [props.networkEnabled, props.behindProxy],
  async (_value, _previous, onCleanup) => {
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    try {
      const [result, workspaces] = await Promise.all([
        apiFetch<McpConnectionInfo>('/api/settings/mcp', { signal: controller.signal }),
        apiFetch<Array<{ id: string; name: string }>>('/api/workspaces', { signal: controller.signal }),
        loadKeys(controller.signal),
      ])
      if (controller.signal.aborted) return
      workspaceOptions.value = workspaces.map((workspace) => ({ label: workspace.name, value: workspace.id }))
      info.value = result
      loadFailed.value = false
      if (!options.value.some((option) => option.value === selectedUrl.value)) selectedUrl.value = info.value.localUrl
    } catch {
      if (controller.signal.aborted) return
      loadFailed.value = true
    }
  },
  { immediate: true },
)

async function copy(text: string) {
  try {
    await copyToClipboard(text)
    $q.notify({ type: 'positive', message: t('settings.network.copied') })
  } catch {
    $q.notify({ type: 'negative', message: t('settings.mcp.copyFailed') })
  }
}

function copyWithToken() {
  if (info.value && selection.value && createdToken.value) {
    void copy(formatMcpConfig(info.value, selection.value, clientName.value, createdToken.value))
  }
}
</script>

<style scoped>
.mcp-config { overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: rgba(0, 0, 0, 0.16); border-radius: 4px; font-size: 12px; }
.mcp-url { overflow-wrap: anywhere; min-width: 0; }
</style>
