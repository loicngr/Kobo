<template>
  <div data-test="slack-settings">
    <div class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md">
      <q-toggle
        :model-value="settings.global.slackEnabled"
        :label="$t('slack.enabled')"
        :disable="busy"
        dark
        dense
        color="primary"
        data-test="slack-enabled"
        @update:model-value="toggleEnabled"
      />
      <div class="text-caption q-mt-sm" role="status" data-test="slack-status">{{ statusLine }}</div>
    </div>

    <div class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md">
      <div v-if="slack.status?.configured" class="text-caption text-kobo-3 q-mb-sm">
        <span class="text-weight-medium text-kobo-1">{{ $t('slack.tokensConfigured') }}</span>
        {{ $t('slack.tokensReplaceHint') }}
      </div>
      <div v-else class="text-caption text-kobo-3 q-mb-sm">{{ $t('slack.tokensHint') }}</div>
      <q-input
        v-model="botToken"
        type="password"
        dense
        dark
        outlined
        autocomplete="new-password"
        :label="$t('slack.botToken')"
        placeholder="xoxb-..."
        class="q-mb-sm settings-input"
        data-test="slack-bot-token"
      />
      <q-input
        v-model="appToken"
        type="password"
        dense
        dark
        outlined
        autocomplete="new-password"
        :label="$t('slack.appToken')"
        placeholder="xapp-..."
        class="q-mb-sm settings-input"
        data-test="slack-app-token"
      />
      <div class="row q-gutter-sm q-mb-sm">
        <q-btn
          outline
          no-caps
          color="primary"
          :label="$t('slack.saveCredentials')"
          :disable="busy || !botToken.trim() || !appToken.trim()"
          data-test="slack-save-credentials"
          @click="saveCredentials"
        />
        <q-btn
          v-if="slack.status?.configured"
          flat
          no-caps
          color="negative"
          :label="$t('slack.removeCredentials')"
          :disable="busy"
          data-test="slack-remove-credentials"
          @click="confirmRemove"
        />
      </div>
      <div v-if="credentialsError" class="text-negative text-caption q-mb-sm" role="alert">{{ credentialsError }}</div>
    </div>

    <div class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md">
      <q-select
        v-model="allowedUserIds"
        multiple
        use-chips
        use-input
        hide-dropdown-icon
        new-value-mode="add-unique"
        dense
        dark
        outlined
        :label="$t('slack.allowedUsers')"
        :hint="$t('slack.allowedUsersHint')"
        :error="!!allowedError"
        :error-message="allowedError"
        class="q-mb-sm settings-input"
        data-test="slack-allowed-users"
        @update:model-value="allowedError = ''"
      />
      <q-btn
        outline
        no-caps
        color="primary"
        class="q-mb-sm"
        :label="$t('slack.saveAllowed')"
        :disable="busy"
        data-test="slack-save-allowed"
        @click="saveAllowed"
      />
    </div>

    <div class="settings-subcard q-pa-md rounded-borders q-pb-sm q-mb-md">
      <q-expansion-item
        dense
        dark
        icon="help_outline"
        :label="$t('slack.guideTitle')"
        class="rounded-borders"
        data-test="slack-guide"
      >
        <div class="q-pa-sm text-caption text-kobo-2" style="line-height: 1.55;">
          <template v-for="step in guideSteps" :key="step">
            <div class="text-weight-medium text-kobo-1 q-mb-xs">{{ $t(`slack.guideStep${step}Title`) }}</div>
            <div class="q-mb-xs">{{ $t(`slack.guideStep${step}Body`) }}</div>
            <template v-if="step === 1">
              <pre class="q-pa-sm rounded-borders bg-black text-kobo-2 overflow-auto text-caption" data-test="slack-manifest">{{ manifest }}</pre>
              <q-btn flat dense no-caps icon="content_copy" :label="$t('common.copy')" class="q-mb-sm" data-test="slack-copy-manifest" @click="copyManifest" />
              <div class="q-mb-xs" data-test="slack-guide-interactivity">{{ $t('slack.guideInteractivity') }}</div>
            </template>
            <div class="q-mb-md" />
          </template>
        </div>
      </q-expansion-item>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useQuasar } from 'quasar'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { SLACK_APP_MANIFEST } from '../../../shared/slack-manifest'
import { useSettingsStore } from '../stores/settings'
import { type SlackErrorCode, useSlackStore } from '../stores/slack'
import { ApiError } from '../utils/api'
import { copyToClipboard } from '../utils/clipboard'

const $q = useQuasar()
const { t } = useI18n()
const settings = useSettingsStore()
const slack = useSlackStore()

const manifest = SLACK_APP_MANIFEST
const guideSteps = [1, 2, 3, 4, 5, 6, 7]
const botToken = ref('')
const appToken = ref('')
const allowedUserIds = ref<string[]>([...(settings.global.slackAllowedUserIds ?? [])])
const allowedError = ref('')
const credentialsError = ref('')
const busy = ref(false)

watch(
  () => settings.global.slackAllowedUserIds,
  (ids) => {
    allowedUserIds.value = [...(ids ?? [])]
  },
)

const statusLine = computed(() => {
  const s = slack.status
  if (!s) return t('slack.status.unavailable')
  if (!s.configured) return t('slack.status.notConfigured')
  if (!s.enabled) return t('slack.status.disabled')
  if (s.connected) return t('slack.status.connected', { bot: s.botName ?? '', team: s.teamName ?? '' })
  return s.error ? t(`slack.error.${s.error satisfies SlackErrorCode}`) : t('slack.status.disconnected')
})

async function refreshStatus() {
  try {
    await slack.fetchStatus()
  } catch {
    slack.status = null
  }
}

// Fetched when the tab is shown (the component is mounted by the tab) and after each change; never polled.
onMounted(refreshStatus)

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : t('slack.saveFailed')
}

async function toggleEnabled(value: boolean) {
  busy.value = true
  try {
    await settings.updateGlobal({ slackEnabled: value })
  } catch (err) {
    $q.notify({ type: 'negative', message: errorMessage(err), position: 'top' })
  } finally {
    busy.value = false
  }
  await refreshStatus()
}

async function saveCredentials() {
  busy.value = true
  credentialsError.value = ''
  try {
    await slack.saveCredentials({ botToken: botToken.value.trim(), appToken: appToken.value.trim() })
    botToken.value = ''
    appToken.value = ''
    $q.notify({ type: 'positive', message: t('slack.credentialsSaved'), position: 'top', timeout: 1500 })
  } catch (err) {
    credentialsError.value = errorMessage(err)
  } finally {
    busy.value = false
  }
}

function confirmRemove() {
  $q.dialog({
    title: t('slack.removeConfirmTitle'),
    message: t('slack.removeConfirm'),
    cancel: true,
    persistent: true,
    dark: true,
  }).onOk(async () => {
    busy.value = true
    credentialsError.value = ''
    try {
      await slack.saveCredentials(null)
      $q.notify({ type: 'positive', message: t('slack.credentialsRemoved'), position: 'top', timeout: 1500 })
    } catch (err) {
      credentialsError.value = errorMessage(err)
    } finally {
      busy.value = false
    }
  })
}

async function saveAllowed() {
  busy.value = true
  allowedError.value = ''
  try {
    await settings.updateGlobal({ slackAllowedUserIds: allowedUserIds.value })
    $q.notify({ type: 'positive', message: t('slack.allowedSaved'), position: 'top', timeout: 1500 })
  } catch (err) {
    // The server names the invalid entry; what the user typed stays in the field.
    allowedError.value = errorMessage(err)
  } finally {
    busy.value = false
  }
}

function copyManifest() {
  void copyToClipboard($q, t, manifest)
}
</script>
