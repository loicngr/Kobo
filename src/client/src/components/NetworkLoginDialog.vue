<template>
  <q-dialog v-model="open" persistent>
    <q-card style="min-width: 320px; max-width: 90vw">
      <q-card-section>
        <div class="text-h6">{{ t('network.login.title') }}</div>
        <div class="text-caption text-grey-7 q-mt-sm">{{ t('network.login.description') }}</div>
      </q-card-section>
      <q-card-section>
        <q-input
          v-model="token"
          :label="t('network.login.tokenLabel')"
          :placeholder="t('network.login.tokenPlaceholder')"
          :error="hasError"
          :error-message="errorMsg"
          autofocus
          dense
          outlined
          @keyup.enter="submit"
        />
      </q-card-section>
      <q-card-actions align="right">
        <q-btn
          :label="t('network.login.connect')"
          color="indigo-4"
          :loading="loading"
          unelevated
          @click="submit"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { setToken } from 'src/utils/auth-token'
import { closeNetworkLogin, networkLoginOpen } from 'src/utils/network-login-bus'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const open = computed({
  get: () => networkLoginOpen.value,
  set: (v) => {
    if (!v) closeNetworkLogin()
  },
})

const token = ref('')
const loading = ref(false)
const hasError = ref(false)
const errorMsg = ref('')

async function submit() {
  const candidate = token.value.trim()
  if (!candidate) return
  loading.value = true
  hasError.value = false
  try {
    // Send the candidate explicitly; only persist it once it actually validates,
    // so a bad attempt never overwrites a previously-working token in storage.
    const res = await fetch('/api/settings/network/ping', { headers: { 'X-Kobo-Token': candidate } })
    if (res.ok) {
      setToken(candidate)
      closeNetworkLogin()
      window.location.reload()
      return
    }
    // Distinguish a rejected token (401) from a server-side problem, so a user
    // who typed the right token isn't told it's "invalid" after a 403/500.
    errorMsg.value = res.status === 401 ? t('network.login.invalid') : t('network.login.serverError')
    hasError.value = true
  } catch {
    // A thrown fetch means the host is unreachable (asleep / Wi-Fi dropped),
    // not a wrong token. Say so.
    errorMsg.value = t('network.login.unreachable')
    hasError.value = true
  } finally {
    loading.value = false
  }
}
</script>
