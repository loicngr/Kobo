<template>
  <div class="column q-gutter-sm q-pa-sm">
    <q-btn
      v-if="isOn"
      dense
      no-caps
      color="negative"
      icon="stop"
      :label="t('autoLoop.stop')"
      @click="onStop"
    />

    <q-btn
      v-else
      dense
      no-caps
      color="indigo-4"
      icon="play_arrow"
      :label="t('autoLoop.start')"
      :disable="startDisabled"
      @click="onStart"
    >
      <q-tooltip v-if="startDisabled && startTooltip">{{ startTooltip }}</q-tooltip>
    </q-btn>

    <q-btn
      v-if="!isReady"
      dense
      no-caps
      outline
      color="indigo-4"
      icon="build"
      :label="t('autoLoop.prepare')"
      :disable="isAgentBusy"
      @click="onPrepare"
    >
      <q-tooltip v-if="isAgentBusy">{{ t('autoLoop.prepareBusy') }}</q-tooltip>
    </q-btn>

    <q-btn
      v-if="!isReady"
      dense
      no-caps
      flat
      size="sm"
      color="grey-5"
      :label="t('autoLoop.forceReady')"
      :disable="isAgentBusy"
      @click="onForceReady"
    >
      <q-tooltip v-if="isAgentBusy">{{ t('autoLoop.prepareBusy') }}</q-tooltip>
    </q-btn>
  </div>
</template>

<script setup lang="ts">
import { useQuasar } from 'quasar'
import { useWebSocketStore } from 'src/stores/websocket'
import { useWorkspaceStore } from 'src/stores/workspace'
import { sendPrepAutoloop } from 'src/utils/kobo-commands'
import { isBusyStatus } from 'src/utils/workspace-status'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const $q = useQuasar()
const store = useWorkspaceStore()
const wsStore = useWebSocketStore()

const ws = computed(() => store.selectedWorkspace)
const status = computed(() => (ws.value ? (store.autoLoopStates[ws.value.id] ?? null) : null))
const hasTasks = computed(() => store.tasks.length > 0)
const isReady = computed(() => !!status.value?.auto_loop_ready)
const isOn = computed(() => !!status.value?.auto_loop)
const canEnable = computed(() => isReady.value && hasTasks.value)
const isAgentBusy = computed(() => isBusyStatus(ws.value?.status))

const startDisabled = computed(() => !canEnable.value)
const startTooltip = computed(() => {
  if (!isReady.value) return t('autoLoop.notReady')
  if (!hasTasks.value) return t('autoLoop.noTasks')
  return ''
})

async function onStart() {
  if (!ws.value) return
  try {
    await store.enableAutoLoop(ws.value.id)
  } catch (err) {
    $q.notify({ type: 'negative', message: String(err), position: 'top', timeout: 4000 })
  }
}

async function onStop() {
  if (!ws.value) return
  try {
    await store.disableAutoLoop(ws.value.id)
  } catch (err) {
    $q.notify({ type: 'negative', message: String(err), position: 'top', timeout: 4000 })
  }
}

function onPrepare() {
  if (!ws.value) return
  void sendPrepAutoloop(ws.value.id, wsStore, store)
}

function onForceReady() {
  if (!ws.value) return
  $q.dialog({
    title: t('autoLoop.forceReady'),
    message: t('autoLoop.forceReadyConfirm'),
    cancel: true,
    persistent: true,
  }).onOk(async () => {
    if (!ws.value) return
    try {
      await store.forceAutoLoopReady(ws.value.id)
    } catch (err) {
      $q.notify({ type: 'negative', message: String(err), position: 'top', timeout: 4000 })
    }
  })
}
</script>
