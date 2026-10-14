<template>
  <span v-if="visible" class="quota-footer">
    <button
      type="button"
      class="quota-trigger"
      data-action="usage-menu"
      :aria-label="title"
      aria-haspopup="dialog"
      :aria-expanded="menuOpen"
      @click="menuOpen = !menuOpen"
    >
      <template v-if="!snapshot">
        <q-icon v-if="accounts?.available || accountError" name="manage_accounts" size="16px" />
        <span class="text-kobo-3">{{ accounts?.available || accountError ? $t('quotaFooter.accounts.trigger') : $t('quotaFooter.empty') }}</span>
      </template>
      <template v-else-if="snapshot.status === 'unauthenticated'">
        <q-icon name="warning" color="negative" size="14px" />
        <span class="text-negative text-weight-medium">{{ $t('quotaFooter.popover.unauthenticated') }}</span>
      </template>
      <template v-else-if="snapshot.status === 'error'">
        <q-icon name="error_outline" color="orange" size="14px" />
        <span class="text-orange text-weight-medium">{{ $t('quotaFooter.popover.error') }}</span>
      </template>
      <template v-else>
        <span v-for="(bucket, idx) in snapshot.buckets" :key="bucket.id" class="quota-bucket-compact">
          <span class="text-kobo-3">{{ bucketLabelFor(bucket.label, idx) }}</span>
          <q-linear-progress :value="Math.max(0, Math.min(1, bucket.usedPct / 100))" :color="usagePctColor(bucket.usedPct)" track-color="kobo-surface-2" class="quota-bar" />
          <span :class="['bucket-pct', `text-${usagePctColor(bucket.usedPct)}`]">{{ bucket.usedPct.toFixed(0) }}%</span>
        </span>
      </template>
    </button>
    <q-menu
      v-model="menuOpen"
      no-parent-event
      anchor="top right"
      self="bottom right"
      class="q-pa-md"
      style="width: 360px; white-space: normal; overflow-wrap: anywhere"
      max-width="min(360px, calc(100vw - var(--kobo-space-2xl)))"
    >
      <section role="dialog" :aria-label="title">
        <div class="text-weight-medium q-mb-sm">{{ title }}</div>
        <template v-if="snapshot">
          <div v-if="snapshot.status === 'unauthenticated'" class="text-caption q-mb-sm">{{ $t('quotaFooter.popover.unauthenticatedHint') }}</div>
          <div v-else-if="snapshot.status === 'error'" class="text-caption text-orange q-mb-sm">{{ snapshot.errorMessage }}</div>
          <template v-else>
            <div v-for="(bucket, idx) in snapshot.buckets" :key="bucket.id" class="q-mb-sm">
              <div class="row items-center justify-between q-mb-xs">
                <span>{{ bucketLabelFor(bucket.label, idx) }}</span>
                <span :class="`text-${usagePctColor(bucket.usedPct)}`">{{ bucket.usedPct.toFixed(0) }}%</span>
              </div>
              <q-linear-progress :value="Math.max(0, Math.min(1, bucket.usedPct / 100))" :color="usagePctColor(bucket.usedPct)" track-color="kobo-surface-2" class="full-bar" />
              <div v-if="bucket.resetsAt" class="text-caption q-mt-xs">{{ $t('quotaFooter.popover.resetsIn', { value: formatRateLimitResetAt(bucket.resetsAt) }) }}</div>
            </div>
            <div class="text-caption q-mt-sm">{{ $t('quotaFooter.lastUpdated', { time: formattedUpdatedAt }) }}</div>
          </template>
        </template>
        <q-btn v-if="providerId === 'claude-code'" flat dense no-caps size="sm" icon="refresh" class="q-mt-sm" :label="$t('quotaFooter.popover.refreshNow')" :loading="refreshing" :disable="refreshing || switching" @click="refresh" />
        <div v-if="accounts?.available || accountError" class="account-section" :aria-busy="loadingAccounts || switching">
          <q-separator v-if="snapshot" class="q-my-md" />
          <template v-if="accounts?.available">
            <div class="text-caption text-kobo-3">{{ $t('quotaFooter.accounts.current') }}</div>
            <div data-current-account class="q-mb-sm">{{ currentAccount ? accountLabel(currentAccount) : $t('quotaFooter.accounts.unknown') }}</div>
            <div v-if="accounts.accounts.length === 0" class="text-caption q-mb-sm">{{ $t('quotaFooter.accounts.empty', { provider: providerName }) }}</div>
            <q-select v-else v-model="selectedAccountId" outlined dense emit-value map-options :options="accountOptions" option-value="id" option-label="label" option-disable="disabled" :label="$t('quotaFooter.accounts.choose')" :disable="loadingAccounts || switching" />
            <div class="text-caption text-kobo-3 q-mt-sm">{{ $t('quotaFooter.accounts.scopeHint', { provider: providerName }) }}</div>
            <q-btn data-action="switch-account" outline dense no-caps size="sm" class="q-mt-sm" :label="$t('quotaFooter.accounts.switch')" :loading="switching" :disable="!canSwitch" @click="switchAccount" />
          </template>
          <div v-if="accountError" role="alert" class="text-caption text-negative q-mt-sm">{{ $t(accountError) }}</div>
          <q-btn flat dense no-caps size="sm" icon="refresh" class="q-mt-sm" :label="$t('quotaFooter.accounts.reload')" :loading="loadingAccounts" :disable="loadingAccounts || switching" @click="loadAccounts()" />
        </div>
      </section>
    </q-menu>
  </span>
</template>

<script setup lang="ts">
import { useWorkspaceStore } from 'src/stores/workspace'
import { apiFetch } from 'src/utils/api'
import { formatRateLimitBucketLabel, formatRateLimitResetAt, usagePctColor } from 'src/utils/rate-limit-labels'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AccountProviderId, ProviderAccount, ProviderAccounts } from '../../../shared/provider-accounts'

const store = useWorkspaceStore()
const { t } = useI18n()
const providerId = computed<AccountProviderId>(() => {
  const session = store.sessions.find(
    (item) => item.id === store.selectedSessionId && item.workspaceId === store.selectedWorkspace?.id,
  )
  return (session?.engine ?? store.selectedWorkspace?.engine) === 'codex' ? 'codex' : 'claude-code'
})
const providerName = computed(() => (providerId.value === 'codex' ? 'Codex' : 'Claude Code'))
const title = computed(() =>
  t(providerId.value === 'codex' ? 'quotaFooter.popover.codexTitle' : 'quotaFooter.popover.title'),
)
// Account discovery is independent of quota support: Codex has no provider quota snapshot.
const snapshot = computed(() =>
  providerId.value === 'claude-code' ? (store.providerUsage['claude-code'] ?? null) : null,
)
const accounts = ref<ProviderAccounts | null>(null)
const selectedAccountId = ref<string | null>(null)
const loadingAccounts = ref(false)
const switching = ref(false)
const accountError = ref('')
const menuOpen = ref(false)
const refreshing = ref(false)
const visible = computed(() => providerId.value === 'claude-code' || accounts.value?.available || !!accountError.value)
const currentAccount = computed(() => accounts.value?.accounts.find((account) => account.active))
const accountOptions = computed(
  () => accounts.value?.accounts.map((account) => ({ ...account, label: accountLabel(account) })) ?? [],
)
const canSwitch = computed(
  () =>
    !loadingAccounts.value &&
    !switching.value &&
    accounts.value?.accounts.some(
      (account) => account.id === selectedAccountId.value && !account.active && !account.disabled,
    ),
)
let generation = 0
let readSequence = 0
let readController: AbortController | null = null

function accountLabel(account: ProviderAccount): string {
  return [account.label, account.email].filter(Boolean).join(' — ') || account.id
}

function accountErrorKey(error: unknown, fallback: string): string {
  return error instanceof Error && 'code' in error && error.code === 'accounts_unsupported_environment'
    ? 'quotaFooter.accounts.unsupportedEnvironment'
    : fallback
}

async function loadAccounts(preserveError = false): Promise<void> {
  if (switching.value) return
  const context = generation
  const sequence = ++readSequence
  const provider = providerId.value
  readController?.abort()
  readController = new AbortController()
  loadingAccounts.value = true
  selectedAccountId.value = null
  if (!preserveError) accountError.value = ''
  try {
    const result = await apiFetch<ProviderAccounts>(`/api/usage/${provider}/accounts`, {
      timeoutMs: 45_000,
      signal: readController.signal,
    })
    if (context !== generation || sequence !== readSequence) return
    accounts.value = result
    if (!result.available) accountError.value = ''
  } catch (error) {
    if (context !== generation || sequence !== readSequence) return
    accounts.value = null
    if (!accountError.value) accountError.value = accountErrorKey(error, 'quotaFooter.accounts.loadError')
  } finally {
    if (context === generation && sequence === readSequence) loadingAccounts.value = false
  }
}

async function switchAccount(): Promise<void> {
  if (!canSwitch.value) return
  const context = generation
  const provider = providerId.value
  const accountId = selectedAccountId.value
  switching.value = true
  accountError.value = ''
  selectedAccountId.value = null
  // A disconnected client must not retain the previous account’s quota snapshot.
  if (provider === 'claude-code') store.providerUsage['claude-code'] = undefined
  try {
    const result = await apiFetch<ProviderAccounts>(`/api/usage/${provider}/accounts/switch`, {
      method: 'POST',
      body: { accountId },
      timeoutMs: 120_000,
    })
    if (context !== generation) return
    accounts.value = result
  } catch (error) {
    if (context !== generation) return
    accountError.value = accountErrorKey(error, 'quotaFooter.accounts.switchError')
    switching.value = false
    await loadAccounts(true)
  } finally {
    if (context === generation) switching.value = false
  }
}

watch(
  () => [store.selectedWorkspace?.id, store.selectedSessionId, providerId.value],
  () => {
    generation++
    readSequence++
    readController?.abort()
    accounts.value = null
    selectedAccountId.value = null
    accountError.value = ''
    switching.value = false
    refreshing.value = false
    menuOpen.value = false
    void loadAccounts()
  },
  { immediate: true, flush: 'sync' },
)
watch(menuOpen, (open) => {
  if (open && !loadingAccounts.value) void loadAccounts()
})
onBeforeUnmount(() => {
  generation++
  readSequence++
  readController?.abort()
})

const formattedUpdatedAt = computed(() => {
  const snap = snapshot.value
  if (!snap) return ''
  try {
    return new Date(snap.fetchedAt).toLocaleTimeString()
  } catch {
    return snap.fetchedAt
  }
})
function bucketLabelFor(rawLabel: string | undefined, idx: number): string {
  const bucket = snapshot.value?.buckets[idx]
  if (!bucket) return t('stats.usageBucket', { n: idx + 1 })
  return formatRateLimitBucketLabel(
    { id: bucket.id, label: rawLabel, usedPct: bucket.usedPct, resetAt: bucket.resetsAt },
    idx,
    t,
  )
}
async function refresh(): Promise<void> {
  if (refreshing.value || switching.value || providerId.value !== 'claude-code') return
  const context = generation
  refreshing.value = true
  try {
    await store.requestUsageRefresh('claude-code')
  } finally {
    if (context === generation) refreshing.value = false
  }
}
</script>

<style lang="scss" scoped>
.quota-footer, .quota-trigger {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}
.quota-trigger {
  border: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
  &:focus-visible { outline: 2px solid var(--kobo-accent); outline-offset: var(--kobo-space-xs); }
}
.quota-bucket-compact { display: inline-flex; align-items: center; gap: 0.3rem; }
.bucket-pct { font-variant-numeric: tabular-nums; }
.quota-bar {
  width: 48px;
  height: 7px;
  border: 1px solid var(--kobo-border-strong);
  border-radius: 4px;
}
.full-bar { height: 6px; border-radius: 3px; }
.account-section { white-space: normal; overflow-wrap: anywhere; }
</style>
