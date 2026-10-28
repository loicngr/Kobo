<template>
  <q-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)">
    <q-card class="pinned-dialog">
      <q-card-section class="row items-center q-pb-sm">
        <div class="text-h6">{{ t(workspaceId ? 'pins.title' : 'pins.allTitle') }}</div>
        <q-space />
        <q-btn flat dense round icon="close" :aria-label="t('common.close')" v-close-popup />
      </q-card-section>
      <q-card-section v-if="snapshot" class="q-pt-none">
        <q-btn flat dense no-caps icon="arrow_back" :label="t('pins.back')" @click="snapshot = null" />
        <p class="text-caption text-kobo-2 q-mt-sm" role="status">{{ t('pins.savedCopy') }}</p>
        <TurnCard v-for="turn in snapshotTurns" :key="turnKey(turn)" :turn="turn"
          :workspace-id="snapshot.pin.workspaceId" :session-id="snapshot.pin.sessionId" disable-pin static-content />
      </q-card-section>
      <q-card-section v-else class="q-pt-none">
        <div v-if="state.loading || busy" role="status" class="q-pa-sm"><q-spinner size="sm" /> {{ t('pins.loading') }}</div>
        <p v-if="state.error" role="alert" class="text-negative">
          {{ t('pins.loadFailed', { message: state.error }) }}
          <q-btn flat dense :label="t('common.retry')" @click="store.load(workspaceId)" />
        </p>
        <p v-if="!state.loading && !state.error && state.pins.length === 0" class="text-kobo-3">{{ t('pins.empty') }}</p>
        <q-list separator>
          <q-item v-for="pin in state.pins" :key="pin.id" class="pinned-row">
            <q-item-section>
              <button type="button" class="pinned-open" :disabled="busy !== null" @click="open(pin)">
                <span class="text-caption text-kobo-3">{{ pin.workspaceName }} · {{ pin.sessionName || t('pins.unnamedSession') }}<template v-if="pin.archived"> · {{ t('pins.archived') }}</template></span>
                <span class="text-caption">{{ t(pin.speaker === 'user' ? 'chat.you' : 'chat.agent') }} · {{ new Date(pin.messageCreatedAt).toLocaleString() }}</span>
                <span class="pinned-preview">{{ pin.preview }}</span>
              </button>
              <div class="row q-gutter-xs">
                <q-btn flat dense no-caps size="sm" :label="t('pins.viewCopy')" :disable="busy !== null" @click="open(pin, true)" />
                <q-btn flat dense no-caps size="sm" :label="t('pins.unpin')" :disable="busy !== null" @click="unpin(pin)" />
              </div>
            </q-item-section>
          </q-item>
        </q-list>
        <q-btn v-if="state.hasMore" flat no-caps :label="t('pins.more')" :disable="state.loading" @click="store.load(workspaceId, true)" />
      </q-card-section>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { Notify } from 'quasar'
import { turnKey } from 'src/services/conversation-turns'
import { pinnedMessageTurns } from 'src/services/pinned-messages'
import { usePinnedMessagesStore } from 'src/stores/pinned-messages'
import { useWorkspaceStore } from 'src/stores/workspace'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import type { PinnedMessage, PinnedMessageDetail } from '../../../shared/pinned-messages'
import TurnCard from './TurnCard.vue'

const props = defineProps<{ modelValue: boolean; workspaceId?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const { t } = useI18n()
const store = usePinnedMessagesStore()
const workspace = useWorkspaceStore()
const router = useRouter()
const state = computed(() => store.list(props.workspaceId))
const snapshot = ref<PinnedMessageDetail | null>(null)
const snapshotTurns = computed(() => (snapshot.value ? pinnedMessageTurns(snapshot.value.events) : []))
const busy = ref<string | null>(null)
let generation = 0
watch(
  () => [props.modelValue, props.workspaceId],
  () => {
    generation++
    snapshot.value = null
    busy.value = null
    if (props.modelValue) void store.load(props.workspaceId)
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  generation++
})

function report(error: unknown) {
  Notify.create({
    type: 'negative',
    message: t('pins.actionFailed', { message: error instanceof Error ? error.message : String(error) }),
  })
}

async function open(pin: PinnedMessage, savedCopy = false) {
  const version = ++generation
  busy.value = pin.id
  const current = () => generation === version && props.modelValue
  let awaitingFocus = false
  const finishFocus = () => {
    if (current()) busy.value = null
  }
  try {
    const detail = await store.detail(pin.id)
    if (!current()) return
    if (savedCopy || !detail.pin.sourceAvailable) {
      snapshot.value = detail
      return
    }
    if (props.workspaceId === pin.workspaceId) {
      if (pin.sessionId) await workspace.fetchSessions(pin.workspaceId, pin.sessionId)
      if (!current()) return
      await nextTick()
      awaitingFocus = true
      window.dispatchEvent(
        new CustomEvent('kobo:focus-history-event', {
          detail: {
            workspaceId: pin.workspaceId,
            sessionId: pin.sessionId,
            eventId: pin.eventId,
            onFocused: () => {
              finishFocus()
              if (current()) emit('update:modelValue', false)
            },
            onUnavailable: () => {
              finishFocus()
              if (current()) snapshot.value = detail
            },
            onError: (error: unknown) => {
              finishFocus()
              if (current()) report(error)
            },
            onCancelled: finishFocus,
          },
        }),
      )
    } else {
      await router.push({
        name: 'workspace',
        params: { id: pin.workspaceId },
        query: { ...(pin.sessionId ? { session: pin.sessionId } : {}), eventId: pin.eventId },
      })
      if (current()) emit('update:modelValue', false)
    }
  } catch (error) {
    if (current()) report(error)
  } finally {
    if (current() && !awaitingFocus) busy.value = null
  }
}

async function unpin(pin: PinnedMessage) {
  const version = generation
  busy.value = pin.id
  try {
    await store.unpin(pin)
  } catch (error) {
    if (version === generation) report(error)
  } finally {
    if (version === generation) busy.value = null
  }
}
</script>

<style scoped>
.pinned-dialog { width: 720px; max-width: calc(100vw - var(--kobo-space-2xl)); max-height: calc(100dvh - var(--kobo-space-2xl)); overflow-y: auto; background: var(--kobo-bg); }
.pinned-row { padding: var(--kobo-space-md) 0; }
.pinned-open { display: flex; flex-direction: column; gap: var(--kobo-space-xs); width: 100%; padding: var(--kobo-space-xs); color: var(--kobo-text); background: none; border: 0; text-align: left; font: inherit; cursor: pointer; }
.pinned-open:hover { background: var(--kobo-hover); }
.pinned-open:focus-visible { outline: 2px solid var(--kobo-accent); outline-offset: 2px; }
.pinned-preview { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
