<template>
  <div v-if="enabled" class="activity-entry" data-tour="activity-digest">
    <q-btn flat dense no-caps class="full-width" align="left" :label="$t('absence.title')" @click="open = true">
      <q-badge v-if="store.items.length" color="primary" class="q-ml-sm">{{ store.items.length }}{{ store.hasMore ? '+' : '' }}</q-badge>
    </q-btn>
    <q-dialog v-model="open">
      <q-card class="activity-dialog">
        <q-card-section class="row items-center no-wrap">
          <strong class="col">{{ $t('absence.title') }}</strong>
          <q-btn flat dense no-caps class="col-auto q-ml-md" :label="$t('common.close')" v-close-popup />
        </q-card-section>
        <q-card-section class="activity-hint">
          {{ $t('absence.retention') }}
          <div v-if="store.since">{{ $t('absence.since', { date: formatDate(store.since) }) }}</div>
        </q-card-section>
        <q-card-section v-if="store.error">
          {{ $t('absence.error') }}
          <q-btn flat no-caps :label="$t('absence.retry')" @click="store.returnToApp()" />
        </q-card-section>
        <q-linear-progress v-if="store.loading" indeterminate />
        <q-card-section v-if="!store.loading && !store.error && !store.items.length">{{ $t('absence.empty') }}</q-card-section>
        <q-list class="activity-items" separator>
          <q-item v-for="item in orderedItems" :key="item.id" clickable @click="openActivity(item)">
            <q-item-section>
              <q-item-label>{{ item.workspaceName }}</q-item-label>
              <q-item-label caption>{{ $t(`absence.kind.${item.kind}`) }}</q-item-label>
            </q-item-section>
            <q-item-section side>{{ formatDate(item.createdAt) }}</q-item-section>
          </q-item>
        </q-list>
        <q-card-actions align="right">
          <q-btn v-if="store.hasMore" flat no-caps :disable="store.loading" :label="$t('absence.more')" @click="store.loadMore()" />
          <q-btn v-if="store.items.length" flat no-caps :disable="store.loading" :label="$t('absence.markRead')" @click="store.markRead()" />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>
<script setup lang="ts">
import { type ActivityItem, useActivityStore } from 'src/stores/activity'
import { useSettingsStore } from 'src/stores/settings'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

const store = useActivityStore()
const settings = useSettingsStore()
const enabled = computed(() => settings.loaded && settings.global.activityDigestEnabled !== false)
const router = useRouter()
const { locale } = useI18n()
const open = ref(false)
const orderedItems = computed(() => [...store.items].reverse())
function formatDate(date: string) {
  return new Date(date).toLocaleString(locale.value)
}
async function openActivity(item: ActivityItem) {
  const result = await router.push({
    name: 'workspace',
    params: { id: item.workspaceId },
    query: item.sessionId ? { session: item.sessionId } : item.kind.startsWith('pr-') ? { panel: 'git' } : {},
  })
  if (!result) open.value = false
}
function visibilityChanged() {
  if (document.visibilityState === 'hidden') store.leaveApp()
  else void store.returnToApp()
}
function connectionLost() {
  store.connectionLost()
}
function connectionRestored() {
  void store.heartbeat()
}
let timer: ReturnType<typeof setInterval> | undefined
function startTracking() {
  visibilityChanged()
  document.addEventListener('visibilitychange', visibilityChanged)
  window.addEventListener('offline', connectionLost)
  window.addEventListener('online', connectionRestored)
  timer = setInterval(() => void store.heartbeat(), 15_000)
}
function stopTracking() {
  open.value = false
  store.leaveApp()
  clearInterval(timer)
  timer = undefined
  document.removeEventListener('visibilitychange', visibilityChanged)
  window.removeEventListener('offline', connectionLost)
  window.removeEventListener('online', connectionRestored)
}
onMounted(() => {
  watch(enabled, (value) => (value ? startTracking() : stopTracking()), { immediate: true })
})
onUnmounted(stopTracking)
</script>
<style scoped>
.activity-entry { display: flex; align-items: center; gap: var(--kobo-space-md); padding: var(--kobo-space-xs) var(--kobo-space-md); flex-shrink: 0; }
.activity-dialog { width: min(90vw, 48rem); background: var(--kobo-surface); }
.activity-hint { color: var(--kobo-text-3); }
.activity-items { max-height: 55dvh; overflow-y: auto; }
</style>
