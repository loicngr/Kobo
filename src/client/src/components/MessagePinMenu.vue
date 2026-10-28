<template>
  <div class="message-pin-menu row items-center no-wrap">
    <q-icon v-if="pin" name="push_pin" size="14px" role="img" :aria-label="t('pins.pinned')">
      <q-tooltip>{{ t('pins.pinned') }}</q-tooltip>
    </q-icon>
    <q-btn flat dense round size="sm" icon="more_vert" :aria-label="t('pins.actions')" :loading="busy" aria-haspopup="menu">
      <q-menu>
        <q-list dense>
          <q-item v-close-popup clickable :disable="busy || (!pin && !persisted)" @click="toggle">
            <q-item-section avatar><q-icon name="push_pin" size="16px" /></q-item-section>
            <q-item-section>{{ t(pin ? 'pins.unpin' : 'pins.pin') }}</q-item-section>
          </q-item>
        </q-list>
      </q-menu>
      <q-tooltip v-if="!persisted && !pin">{{ t('pins.notSaved') }}</q-tooltip>
    </q-btn>
  </div>
</template>

<script setup lang="ts">
import { Notify } from 'quasar'
import { itemKey, type Turn } from 'src/services/conversation-turns'
import { usePinnedMessagesStore } from 'src/stores/pinned-messages'
import { useWorkspaceStore } from 'src/stores/workspace'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = withDefaults(
  defineProps<{ turn: Turn; workspaceId: string; sessionId?: string | null; pinReady?: boolean }>(),
  { pinReady: true },
)
const { t } = useI18n()
const store = usePinnedMessagesStore()
const workspace = useWorkspaceStore()
const busy = ref(false)
const pin = computed(() => store.find(props.workspaceId, props.sessionId ?? null, props.turn.items.map(itemKey)))
const ids = computed(() => [...new Set(props.turn.items.flatMap((item) => item.eventIds ?? []))])
const persisted = computed(
  () =>
    props.pinReady !== false &&
    (props.sessionId != null || workspace.sessions.length === 0) &&
    props.turn.items.length > 0 &&
    props.turn.items.every((item) => item.eventIds?.length) &&
    !(workspace.activityFeeds[props.workspaceId] ?? []).some(
      (item) => ids.value.includes(item.id) && item.meta?.pending,
    ),
)

async function toggle() {
  if (busy.value || (!pin.value && !persisted.value)) return
  busy.value = true
  try {
    if (pin.value) await store.unpin(pin.value)
    else await store.pin(props.workspaceId, props.sessionId ?? null, ids.value)
  } catch (error) {
    Notify.create({
      type: 'negative',
      message: t('pins.actionFailed', { message: error instanceof Error ? error.message : String(error) }),
    })
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.message-pin-menu { margin-left: auto; flex-shrink: 0; }
</style>
