<template>
  <section data-tour="settings-mcp" class="q-mt-lg">
    <div class="text-subtitle2 q-mb-sm">{{ t('settings.mcp.title') }}</div>
    <p class="text-caption text-kobo-3">{{ t('settings.mcp.hint') }}</p>
    <q-banner v-if="loadFailed" dense class="bg-negative text-white">{{ t('settings.network.loadFailed') }}</q-banner>
    <template v-else-if="info">
      <p v-if="!networkEnabled" class="text-caption text-kobo-3">{{ t('settings.mcp.remoteDisabled') }}</p>
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
          <q-btn v-if="requiresToken" outline dense no-caps :disable="!token || !networkEnabled" :label="t('settings.mcp.copyWithToken')" @click="copyWithToken" />
        </div>
        <p v-if="requiresToken && !token" class="text-caption text-kobo-3 q-mt-sm">{{ t('settings.mcp.tokenUnavailable') }}</p>
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

const props = defineProps<{ token: string; networkEnabled: boolean; behindProxy: boolean }>()
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
const requiresToken = computed(() =>
  selection.value === 'stdio' ? info.value?.localRequiresToken : selection.value?.requiresToken,
)

watch(
  () => [props.networkEnabled, props.behindProxy],
  async (_value, _previous, onCleanup) => {
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    try {
      const result = await apiFetch<McpConnectionInfo>('/api/settings/mcp', { signal: controller.signal })
      if (controller.signal.aborted) return
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
  if (info.value && selection.value && props.token && props.networkEnabled) {
    void copy(formatMcpConfig(info.value, selection.value, clientName.value, props.token))
  }
}
</script>

<style scoped>
.mcp-config { overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: rgba(0, 0, 0, 0.16); border-radius: 4px; font-size: 12px; }
.mcp-url { overflow-wrap: anywhere; min-width: 0; }
</style>
