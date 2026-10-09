<template>
  <section v-if="visible" class="auto-loop-panel text-caption" :aria-label="t('autoLoop.toggle')">
    <div class="auto-loop-panel__heading">
      <div class="auto-loop-panel__status" :class="{ 'auto-loop-panel__status--blocked': state === 'blocked' }" role="status">
        <strong>{{ t('autoLoop.toggle') }} · {{ t(`autoLoop.status.${state}`) }}</strong>
        <span v-if="status?.phase">{{ t(`autoLoop.phase.${status.phase}`) }}</span>
        <span v-if="status?.iteration">{{ t('autoLoop.iteration', { count: status.iteration }) }}</span>
      </div>
      <div class="auto-loop-panel__actions">
        <q-btn
          v-if="state === 'blocked' && !hasUnknown"
          flat dense no-caps size="sm" data-test="loop-resume"
          :label="t('autoLoop.resume')" :disable="busy" :loading="pendingAction === 'resume'"
          @click="runAction('resume', (id) => store.enableAutoLoop(id))"
        />
        <q-btn
          v-if="status?.auto_loop"
          flat dense no-caps size="sm" data-test="loop-stop"
          :label="t('autoLoop.stop')" :disable="busy" :loading="pendingAction === 'stop'"
          @click="runAction('stop', (id) => store.disableAutoLoop(id))"
        />
        <q-btn
          v-if="canDismiss"
          flat dense no-caps size="sm" data-test="loop-dismiss"
          :label="t('common.dismiss')" :disable="busy"
          @click="dismiss"
        />
      </div>
    </div>
    <p v-if="status?.finalReview?.configuration" class="auto-loop-panel__detail" role="status">
      {{ t(`autoLoop.finalReview.${status.finalReview.state}`) }}
      <span v-if="status.finalReview.cycle"> · {{ t('autoLoop.finalReview.cycle', { count: status.finalReview.cycle }) }}</span>
      <span v-if="status.finalReview.findingsCount !== null"> · {{ t('autoLoop.finalReview.findings', { count: status.finalReview.findingsCount }) }}</span>
    </p>
    <p v-if="reason" class="auto-loop-panel__detail">{{ reason }}</p>
    <p v-if="status?.retry_at" class="auto-loop-panel__detail">
      {{ t('autoLoop.retryAt') }} <time :datetime="status.retry_at">{{ retryAt }}</time>
    </p>
    <details v-if="messages.length" :open="hasUnknown" class="auto-loop-panel__messages">
      <summary>{{ t('autoLoop.messages.count', { count: messages.length }) }}</summary>
      <p v-if="hasUnknown" class="auto-loop-panel__detail">{{ t('autoLoop.messages.unknownHelp') }}</p>
      <ol>
        <li v-for="message in messages" :key="message.id">
          <span class="auto-loop-panel__message-state">{{ t(`autoLoop.messages.${message.state}`) }}</span>
          <p class="auto-loop-panel__content">{{ message.content }}</p>
          <div class="auto-loop-panel__actions">
            <q-btn
              v-if="message.state === 'pending'"
              flat dense no-caps size="sm" :data-test="`message-cancel-${message.id}`"
              :label="t('autoLoop.messages.cancel')" :disable="busy"
              @click="resolveMessage(message.id, 'cancel')"
            />
            <template v-if="message.state === 'unknown'">
              <q-btn
                flat dense no-caps size="sm" :data-test="`message-acknowledge-${message.id}`"
                :label="t('autoLoop.messages.acknowledge')" :disable="busy"
                @click="resolveMessage(message.id, 'acknowledge')"
              />
              <q-btn
                flat dense no-caps size="sm" :data-test="`message-retry-${message.id}`"
                :label="t('autoLoop.messages.retry')" :disable="busy"
                @click="resolveMessage(message.id, 'retry')"
              />
            </template>
          </div>
        </li>
      </ol>
    </details>
    <p v-if="error" role="alert" class="auto-loop-panel__error">{{ error }}</p>
  </section>
</template>

<script setup lang="ts">
import { useWorkspaceStore } from 'src/stores/workspace'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ workspaceId: string }>()
const store = useWorkspaceStore()
const { t, te, locale } = useI18n()
const pendingAction = ref<string | null>(null)
const error = ref('')
const dismissedRun = ref<string | null>(null)
const dismissalKey = computed(() => `kobo:dismissed-auto-loop:${props.workspaceId}`)
const status = computed(() => store.autoLoopStates[props.workspaceId])
const state = computed(() => status.value?.state ?? (status.value?.auto_loop ? 'active' : 'stopped'))
const messages = computed(() =>
  (store.autoLoopMessages[props.workspaceId] ?? []).filter((message) => message.state !== 'delivered'),
)
const hasUnknown = computed(() => messages.value.some((message) => message.state === 'unknown'))
const busy = computed(() => pendingAction.value !== null)
const terminal = computed(() => state.value === 'completed' || state.value === 'stopped')
const canDismiss = computed(() => terminal.value && !status.value?.auto_loop && messages.value.length === 0)
const runSignature = computed(() =>
  JSON.stringify([state.value, status.value?.iteration ?? 0, status.value?.current_session_id ?? null]),
)
// Queue fetches also run for manual workspaces; an error alone is not loop activity.
const visible = computed(() =>
  Boolean(
    !(canDismiss.value && dismissedRun.value === runSignature.value) &&
      (status.value?.auto_loop ||
        state.value === 'blocked' ||
        state.value === 'completed' ||
        status.value?.iteration ||
        messages.value.length),
  ),
)
const reason = computed(() => {
  const value = status.value?.reason
  if (!value) return ''
  const key = `autoLoop.reason.${value}`
  return te(key) ? t(key) : value
})
const retryAt = computed(() => {
  const value = status.value?.retry_at
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale.value)
})

watch(
  () => props.workspaceId,
  async (id) => {
    try {
      dismissedRun.value = localStorage.getItem(dismissalKey.value)
    } catch {
      dismissedRun.value = null
    }
    error.value = ''
    pendingAction.value = null
    if (!id) return
    try {
      await store.fetchAutoLoopMessages(id)
    } catch (cause) {
      if (props.workspaceId === id) error.value = cause instanceof Error ? cause.message : t('autoLoop.actionFailed')
    }
  },
  { immediate: true },
)

watch(
  [() => props.workspaceId, () => status.value?.auto_loop, terminal],
  () => {
    if (!status.value || (!status.value.auto_loop && terminal.value)) return
    dismissedRun.value = null
    try {
      localStorage.removeItem(dismissalKey.value)
    } catch {
      // Keep the panel usable when browser storage is unavailable.
    }
  },
  { immediate: true },
)

function dismiss(): void {
  if (!canDismiss.value || busy.value) return
  dismissedRun.value = runSignature.value
  try {
    localStorage.setItem(dismissalKey.value, dismissedRun.value)
  } catch {
    // The dismissal still applies for the current view.
  }
}

async function runAction(action: string, run: (id: string) => Promise<void>): Promise<void> {
  if (busy.value || !props.workspaceId) return
  const id = props.workspaceId
  pendingAction.value = action
  error.value = ''
  try {
    await run(id)
  } catch (cause) {
    if (props.workspaceId === id) error.value = cause instanceof Error ? cause.message : t('autoLoop.actionFailed')
  } finally {
    if (props.workspaceId === id) pendingAction.value = null
  }
}

function resolveMessage(messageId: number, action: 'cancel' | 'acknowledge' | 'retry'): Promise<void> {
  return runAction(`${action}-${messageId}`, (id) => store.resolveAutoLoopMessage(id, messageId, action))
}
</script>

<style scoped lang="scss">
.auto-loop-panel {
  padding: var(--kobo-space-sm);
  color: var(--kobo-text-2);
  border-bottom: 1px solid var(--kobo-border-subtle);
}

.auto-loop-panel__heading,
.auto-loop-panel__status,
.auto-loop-panel__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--kobo-space-sm);
}

.auto-loop-panel__heading { justify-content: space-between; }
.auto-loop-panel__status--blocked { color: var(--kobo-warning); }
.auto-loop-panel__detail { margin: var(--kobo-space-xs) 0; }
.auto-loop-panel__error { color: var(--kobo-danger); margin: var(--kobo-space-xs) 0; }
.auto-loop-panel__messages { margin-top: var(--kobo-space-sm); }
.auto-loop-panel__messages summary { cursor: pointer; }
.auto-loop-panel__messages ol {
  margin: var(--kobo-space-sm) 0;
  padding-left: var(--kobo-space-xl);
  max-height: calc(var(--kobo-space-4xl) * 4);
  overflow-y: auto;
}
.auto-loop-panel__messages li + li { margin-top: var(--kobo-space-sm); }
.auto-loop-panel__message-state { color: var(--kobo-text-3); }
.auto-loop-panel__content {
  margin: var(--kobo-space-xs) 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
