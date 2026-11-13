<template>
  <q-separator v-if="settings.global.slackEnabled" class="q-my-sm" />
  <q-item v-if="settings.global.slackEnabled" data-test="workspace-slack-channel">
    <q-item-section @click.stop>
      <q-select
        :model-value="current"
        :options="options"
        :label="$t('slack.channel.label')"
        :hint="error || $t('slack.channel.hint')"
        :error="!!error"
        :loading="loading || saving"
        :disable="saving"
        option-value="id"
        option-label="name"
        option-disable="disabled"
        emit-value
        map-options
        clearable
        dense
        dark
        borderless
        options-dense
        class="full-width text-caption"
        @update:model-value="link"
      >
        <template #option="{ itemProps, opt }">
          <q-item v-bind="itemProps">
            <q-item-section>
              <q-item-label>#{{ opt.name }}</q-item-label>
              <q-item-label v-if="opt.disabled" caption>{{ $t('slack.channel.linkedElsewhere') }}</q-item-label>
            </q-item-section>
          </q-item>
        </template>
      </q-select>
    </q-item-section>
  </q-item>
  <q-item v-if="settings.global.slackEnabled && slackChannelId" data-test="workspace-slack-question-mirror">
    <q-item-section @click.stop>
      <q-select
        :model-value="slackQuestionMirror"
        :options="mirrorOptions"
        :label="$t('slack.questionMirror.label')"
        :hint="mirrorError || $t('slack.questionMirror.hint')"
        :error="!!mirrorError"
        :loading="savingMirror"
        :disable="savingMirror"
        emit-value
        map-options
        dense
        dark
        borderless
        options-dense
        class="full-width text-caption"
        @update:model-value="setMirror"
      />
    </q-item-section>
  </q-item>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SlackQuestionMirror } from '../../../shared/slack-question-mirror'
import { useSettingsStore } from '../stores/settings'
import { type SlackChannel, useSlackStore } from '../stores/slack'
import { useWorkspaceStore } from '../stores/workspace'
import { ApiError } from '../utils/api'

const props = defineProps<{
  workspaceId: string
  slackChannelId: string | null
  slackQuestionMirror: SlackQuestionMirror
  open: boolean
}>()
const { t } = useI18n()
const settings = useSettingsStore()
const slack = useSlackStore()
const workspaceStore = useWorkspaceStore()

const channels = ref<SlackChannel[]>([])
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const savingMirror = ref(false)
const mirrorError = ref('')
const mirrorOptions = computed(() => [
  { value: 'never', label: t('slack.questionMirror.never') },
  { value: 'slack-conversation', label: t('slack.questionMirror.slackConversation') },
  { value: 'always', label: t('slack.questionMirror.always') },
])

const current = computed(() => props.slackChannelId)
const options = computed(() => {
  const list = channels.value.map((c) => ({
    id: c.id,
    name: c.name,
    disabled: c.workspaceId !== null && c.workspaceId !== props.workspaceId,
  }))
  // Keep the linked channel visible even before the list loads or when Slack is unreachable.
  if (current.value && !list.some((c) => c.id === current.value))
    list.unshift({ id: current.value, name: current.value, disabled: false })
  return list
})

function messageFor(err: unknown): string {
  if (err instanceof ApiError && err.status === 409) return t('slack.channel.taken')
  if (err instanceof ApiError && err.status === 503) return t('slack.channel.notConnected')
  return t('slack.channel.failed')
}

// Channels are listed from Slack on demand: when the configuration menu opens, never at page mount.
watch(
  () => props.open,
  async (open) => {
    if (!open || !settings.global.slackEnabled) return
    loading.value = true
    error.value = ''
    try {
      channels.value = await slack.fetchChannels()
    } catch (err) {
      error.value = messageFor(err)
    } finally {
      loading.value = false
    }
  },
  { immediate: true },
)

async function link(channelId: string | null) {
  saving.value = true
  error.value = ''
  try {
    const slackChannelId = await slack.linkChannel(props.workspaceId, channelId)
    workspaceStore.updateWorkspaceFromEvent(props.workspaceId, { slackChannelId })
  } catch (err) {
    // The previous value stays: the selector is bound to the workspace, which is not changed on failure.
    error.value = messageFor(err)
  } finally {
    saving.value = false
  }
}

async function setMirror(mode: SlackQuestionMirror) {
  savingMirror.value = true
  mirrorError.value = ''
  try {
    const slackQuestionMirror = await slack.setQuestionMirror(props.workspaceId, mode)
    workspaceStore.updateWorkspaceFromEvent(props.workspaceId, { slackQuestionMirror })
  } catch {
    // The previous value stays: the select is bound to the workspace, which is not changed on failure.
    mirrorError.value = t('slack.questionMirror.failed')
  } finally {
    savingMirror.value = false
  }
}
</script>
