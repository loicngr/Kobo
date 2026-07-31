<template>
  <div v-if="offline || installPrompt || updateReady" class="pwa-status-banner row items-center q-gutter-sm q-px-md q-py-sm">
    <q-icon :name="offline ? 'cloud_off' : updateReady ? 'system_update' : 'install_mobile'" size="18px" color="indigo-3" />
    <span class="text-caption col">
      {{ offline ? $t('pwa.offline') : updateReady ? $t('pwa.updateReady') : $t('pwa.installReady') }}
    </span>
    <q-btn
      v-if="installPrompt"
      dense
      flat
      no-caps
      color="indigo-3"
      :label="$t('pwa.install')"
      @click="install"
    />
    <q-btn
      v-if="updateReady"
      dense
      flat
      no-caps
      color="indigo-3"
      :label="$t('pwa.reload')"
      @click="reloadForUpdate"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const installPrompt = ref<BeforeInstallPromptEvent | null>(null)
const offline = ref(!navigator.onLine)
const updateReady = ref(false)
let registration: ServiceWorkerRegistration | undefined
let reloading = false

function onBeforeInstallPrompt(event: Event) {
  event.preventDefault()
  installPrompt.value = event as BeforeInstallPromptEvent
}

function onOnlineChange() {
  offline.value = !navigator.onLine
}

async function install() {
  const prompt = installPrompt.value
  if (!prompt) return
  await prompt.prompt()
  await prompt.userChoice
  installPrompt.value = null
}

function reloadForUpdate() {
  if (!registration?.waiting) return
  reloading = true
  registration.waiting.postMessage({ type: 'SKIP_WAITING' })
}

onMounted(async () => {
  window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
  window.addEventListener('online', onOnlineChange)
  window.addEventListener('offline', onOnlineChange)
  if (!('serviceWorker' in navigator)) return
  registration = await navigator.serviceWorker.getRegistration()
  if (!registration) return
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) window.location.reload()
  })
  updateReady.value = Boolean(registration.waiting)
  registration.addEventListener('updatefound', () => {
    const worker = registration?.installing
    if (!worker) return
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) updateReady.value = true
    })
  })
})

onUnmounted(() => {
  window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
  window.removeEventListener('online', onOnlineChange)
  window.removeEventListener('offline', onOnlineChange)
})
</script>

<style scoped>
.pwa-status-banner {
  background: rgba(57, 73, 171, 0.16);
  border-bottom: 1px solid rgba(121, 134, 203, 0.25);
}
</style>
