<template>
  <section
    v-if="rows.length || store.error === 'dismiss'"
    ref="panelRef"
    class="session-progress"
    data-tour="ws-progress"
    :aria-label="t('progress.title')"
  >
    <div class="progress-rows" :class="{ expanded }">
      <div v-for="item in displayed" :key="item.id" class="progress-row" :data-status="item.status">
        <div class="progress-content">
          <div class="progress-heading">
            <span class="progress-label">{{ item.label }}</span>
            <span class="progress-status">{{ t(`progress.status.${item.status}`) }}</span>
          </div>
          <div v-if="item.step" class="progress-step">{{ item.step }}</div>
          <div class="progress-meter-row">
            <div
              class="progress-track"
              :class="{ indeterminate: item.total === null }"
              role="progressbar"
              :aria-label="item.label"
              :aria-valuemin="item.total === null ? undefined : 0"
              :aria-valuemax="item.total ?? undefined"
              :aria-valuenow="item.total === null ? undefined : (item.current ?? 0)"
              :aria-valuetext="item.total === null ? t(`progress.status.${item.status}`) : undefined"
            >
              <div v-if="item.total !== null" class="progress-fill" :style="{ width: `${Math.min(100, (item.current ?? 0) / item.total * 100)}%` }" />
            </div>
            <span v-if="item.total !== null" class="progress-values">{{ item.current ?? 0 }} / {{ item.total }}</span>
          </div>
        </div>
        <button
          type="button"
          class="progress-dismiss"
          :data-dismiss="item.id"
          :aria-label="t('progress.dismiss', { label: item.label })"
          :title="t('progress.dismissHint')"
          @click="store.dismiss(item.id)"
        ><span class="material-icons" aria-hidden="true">close</span></button>
      </div>
    </div>
    <button v-if="rows.length > 3" type="button" class="progress-overflow" data-action="overflow" :aria-expanded="expanded" @click="expanded = !expanded">
      {{ expanded ? t('progress.collapse') : t('progress.others', { count: rows.length - 3 }) }}
    </button>
    <div v-if="store.error" class="progress-error" role="alert">
      {{ t(store.error === 'load' ? 'progress.loadError' : 'progress.dismissError') }}
      <button v-if="store.error === 'load'" type="button" class="progress-overflow" @click="store.refresh()">{{ t('progress.retry') }}</button>
    </div>
    <span class="progress-announcement" role="status" aria-live="polite" aria-atomic="true">{{ announcement }}</span>
  </section>
</template>

<script setup lang="ts">
import { useProgressBarsStore } from 'src/stores/progress-bars'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ workspaceId: string; sessionId: string | null }>()
const emit = defineEmits<{ focusComposer: [] }>()
const { t } = useI18n()
const store = useProgressBarsStore()
const expanded = ref(false)
const panelRef = ref<HTMLElement>()
const announcement = ref('')
const rows = computed(() =>
  store.workspaceId === props.workspaceId && store.sessionId === props.sessionId ? store.visible : [],
)
const displayed = computed(() => (expanded.value ? rows.value : rows.value.slice(0, 3)))
watch(
  () => [props.workspaceId, props.sessionId] as const,
  ([workspaceId, sessionId]) => {
    expanded.value = false
    announcement.value = ''
    store.selectScope(workspaceId, sessionId)
    void store.refresh()
  },
  { immediate: true, flush: 'sync' },
)

// Announce terminal transitions only; numeric ticks never flood a live region.
watch(
  () => rows.value.map((item) => ({ id: item.id, status: item.status, label: item.label })),
  (current, previous) => {
    const ended = current.filter(
      (item) => item.status !== 'running' && previous.some((old) => old.id === item.id && old.status === 'running'),
    )
    if (ended.length)
      announcement.value = ended.map((item) => `${item.label}: ${t(`progress.status.${item.status}`)}`).join('. ')
  },
)
watch(
  () => ({ ids: displayed.value.map((item) => item.id), hasOverflow: rows.value.length > 3 }),
  (current, previous) => {
    const active = document.activeElement as HTMLElement | null
    if (!active || !panelRef.value?.contains(active)) return
    const focusedId = active.dataset.dismiss
    const removedDismiss = focusedId !== undefined && !current.ids.includes(focusedId)
    const removedOverflow = active.dataset.action === 'overflow' && !current.hasOverflow
    if (!removedDismiss && !removedOverflow) return
    const index = focusedId ? previous.ids.indexOf(focusedId) : previous.ids.length - 1
    void nextTick(() => {
      // A user may have focused another control while this render was pending.
      if (document.activeElement !== active && document.activeElement !== document.body) return
      const buttons = panelRef.value?.querySelectorAll<HTMLButtonElement>('[data-dismiss]')
      const next = buttons?.[Math.min(Math.max(index, 0), buttons.length - 1)]
      if (next) next.focus()
      else emit('focusComposer')
    })
  },
)
onBeforeUnmount(() => store.reset())
</script>

<style scoped lang="scss">
.session-progress {
  flex: 0 0 auto;
  min-width: 0;
  border-top: 1px solid var(--kobo-border-subtle);
  padding: var(--kobo-space-xs) var(--kobo-space-sm);
  color: var(--kobo-text-2);
  background: var(--kobo-bg);
  font-size: 13px;
}
.progress-rows {
  max-height: min(30vh, 240px);
  overflow-y: auto;
  overscroll-behavior: contain;
}
.progress-row {
  display: flex;
  align-items: center;
  gap: var(--kobo-space-sm);
  padding: var(--kobo-space-xs) 0;
  & + & { border-top: 1px solid var(--kobo-border-subtle); }
}
.progress-content { flex: 1; min-width: 0; }
.progress-heading { display: flex; flex-wrap: wrap; gap: var(--kobo-space-xs) var(--kobo-space-sm); }
.progress-label { overflow-wrap: anywhere; font-weight: 500; color: var(--kobo-text); }
.progress-status { margin-left: auto; color: var(--kobo-text-3); }
.progress-step { overflow-wrap: anywhere; color: var(--kobo-text-3); }
.progress-meter-row { display: flex; align-items: center; gap: var(--kobo-space-sm); margin-top: var(--kobo-space-xs); }
.progress-track { flex: 1; height: var(--kobo-space-xs); background: var(--kobo-border); overflow: hidden; }
.progress-track.indeterminate { border: 1px solid var(--kobo-text-3); background: var(--kobo-surface-2); }
.progress-fill { height: 100%; background: var(--kobo-text-2); }
.progress-values { font-variant-numeric: tabular-nums; font-size: 12px; }
[data-status='succeeded'] .progress-status { color: var(--kobo-success); }
[data-status='failed'] .progress-status { color: var(--kobo-danger); }
[data-status='interrupted'] .progress-status { color: var(--kobo-warning); }
.progress-dismiss, .progress-overflow {
  font: inherit;
  color: var(--kobo-text-2);
  background: transparent;
  border: 0;
  border-radius: var(--kobo-radius-sm);
  cursor: pointer;
  &:hover { background: var(--kobo-hover); }
  &:focus-visible { outline: 2px solid var(--kobo-accent); outline-offset: -2px; }
}
.progress-dismiss { flex: 0 0 44px; width: 44px; min-height: 44px; display: grid; place-items: center; }
.progress-dismiss .material-icons { font-size: 16px; }
.progress-overflow { min-height: 44px; padding: var(--kobo-space-xs) var(--kobo-space-sm); max-width: 100%; overflow-wrap: anywhere; }
.progress-error { color: var(--kobo-danger); overflow-wrap: anywhere; }
.progress-announcement { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>
