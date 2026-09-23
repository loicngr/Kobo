<template>
  <q-expansion-item :label="$t('integration.direct')" class="q-mb-md">
    <div class="q-pa-sm q-gutter-sm">
      <p>{{ $t('integration.directHint') }}</p>
      <p class="text-caption">{{ $t('integration.agentScope') }}</p>
      <p v-if="configured">{{ $t('integration.stored') }}</p>
      <q-input :model-value="draft.command" outlined dense :label="$t('integration.command')" :placeholder="$t('integration.example', { example: examples.command })" stack-label :disable="busy" autocomplete="off" @update:model-value="updateDraft('command', $event)" />
      <q-input :model-value="draft.args" outlined dense type="textarea" :label="$t('integration.args')" :placeholder="$t('integration.example', { example: examples.args })" stack-label :disable="busy" autocomplete="off" spellcheck="false" @update:model-value="updateDraft('args', $event)" />
      <q-input :model-value="draft.environment" outlined dense type="textarea" :label="$t('integration.environment')" :placeholder="$t('integration.example', { example: examples.environment })" stack-label :disable="busy" autocomplete="off" spellcheck="false" @update:model-value="updateDraft('environment', $event)" />
      <p v-if="failed" role="alert" class="text-negative">{{ $t('integration.failed') }}</p>
      <p v-if="saved" role="status">{{ $t('integration.saved') }}</p>
      <div class="row q-gutter-sm">
        <q-btn outline no-caps :label="$t('integration.save')" :disable="busy || !loaded || !draft.command.trim()" @click="save" />
        <q-btn flat no-caps :label="$t('integration.clear')" :disable="busy || !loaded || !configured" @click="persist(null)" />
        <q-btn v-if="!loaded" flat no-caps :label="$t('setup.check')" :loading="busy" @click="load" />
      </div>
    </div>
  </q-expansion-item>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { apiFetch } from '../utils/api'

const { t } = useI18n()
const props = defineProps<{ integration: 'notion' | 'sentry' }>()
const draft = defineModel<{ command: string; args: string; environment: string }>({
  default: () => ({ command: '', args: '', environment: '' }),
})
const examples = computed(() => ({
  command: 'npx',
  args: JSON.stringify([
    '-y',
    props.integration === 'notion' ? '@notionhq/notion-mcp-server' : t('integration.packageExample'),
  ]),
  environment: JSON.stringify(
    props.integration === 'notion'
      ? { NOTION_TOKEN: t('integration.tokenExample') }
      : { [t('integration.variableExample')]: t('integration.valueExample') },
  ),
}))
const connectionStatus = defineModel<{ configured: boolean }>('connectionStatus', {
  default: () => reactive({ configured: false }),
})
const configured = computed(() => connectionStatus.value.configured)
const loaded = ref(false)
const busy = ref(false)
const failed = ref(false)
const saved = ref(false)

function updateDraft(field: 'command' | 'args' | 'environment', value: string | number | null) {
  draft.value = { ...draft.value, [field]: String(value ?? '') }
}

async function load() {
  busy.value = true
  failed.value = false
  try {
    connectionStatus.value.configured = (
      await apiFetch<{ configured: boolean }>(`/api/integrations/${props.integration}`)
    ).configured
    loaded.value = true
  } catch {
    failed.value = true
  } finally {
    busy.value = false
  }
}
async function persist(config: unknown) {
  if (!loaded.value || busy.value) return
  const submittedDraft = draft.value
  busy.value = true
  failed.value = false
  saved.value = false
  try {
    const result = await apiFetch<{ configured: boolean }>(`/api/integrations/${props.integration}`, {
      method: 'PUT',
      body: config === null ? 'null' : config,
    })
    connectionStatus.value.configured = result.configured
    // Tab changes can unmount this component before completion, when Vue no
    // longer delivers model events. Clear the exact submitted object retained
    // by the page; later edits replace that object and must remain untouched.
    Object.assign(submittedDraft, { command: '', args: '', environment: '' })
    if (draft.value === submittedDraft) draft.value = { ...submittedDraft }
    saved.value = true
  } catch {
    failed.value = true
  } finally {
    busy.value = false
  }
}
async function save() {
  try {
    const config = {
      command: draft.value.command,
      args: JSON.parse(draft.value.args.trim() || '[]'),
      env: JSON.parse(draft.value.environment.trim() || '{}'),
    }
    await persist(config)
  } catch {
    failed.value = true
    saved.value = false
  }
}
onMounted(load)
</script>
