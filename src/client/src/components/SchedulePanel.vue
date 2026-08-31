<template>
  <div class="column q-pa-md q-gutter-lg">
    <header class="row items-center no-wrap q-gutter-sm">
      <div class="schedule-header__icon">
        <q-icon name="calendar_month" size="22px" />
      </div>
      <div>
        <div class="text-subtitle1 text-weight-medium">{{ $t('schedule.panelTitle') }}</div>
        <div class="text-caption text-kobo-3">{{ $t('schedule.panelDescription') }}</div>
      </div>
    </header>

    <section>
      <div class="row items-center justify-between q-mb-sm">
        <div class="text-subtitle2">{{ $t('schedule.activeTitle') }}</div>
        <q-badge v-if="activeCount > 0" rounded color="primary" :label="activeCount" />
      </div>

      <q-card v-if="activeCount === 0" dark flat bordered class="empty-state row items-center q-gutter-sm q-pa-md">
        <q-icon name="event_available" size="24px" color="kobo-3" />
        <div>
          <div class="text-body2 text-weight-medium">{{ $t('schedule.emptyTitle') }}</div>
          <div class="text-caption text-kobo-3">{{ $t('schedule.emptyDescription') }}</div>
        </div>
      </q-card>

      <div v-else class="column q-gutter-sm">
        <q-card v-if="pendingWakeup" dark flat bordered class="schedule-item schedule-item--wakeup">
          <q-card-section>
            <div class="row items-start no-wrap q-gutter-sm">
              <div class="schedule-item__icon schedule-item__icon--wakeup">
                <q-icon name="alarm" size="18px" />
              </div>
              <div class="col min-width-zero">
                <div class="text-caption text-kobo-3">{{ $t('schedule.wakeupTitle') }}</div>
                <div class="text-body2 text-weight-medium">{{ formatDateTime(pendingWakeup.targetAt) }}</div>
              </div>
              <q-btn
                flat
                dense
                round
                icon="delete_outline"
                size="sm"
                color="kobo-2"
                :title="$t('schedule.cancelWakeup')"
                @click="cancelWakeup"
              />
            </div>
            <div v-if="pendingWakeup.reason" class="prompt-preview schedule-item__prompt">
              {{ pendingWakeup.reason }}
            </div>
          </q-card-section>
        </q-card>

        <q-card v-for="cron in crons" :key="cron.id" dark flat bordered class="schedule-item">
          <q-card-section>
            <div class="row items-start no-wrap q-gutter-sm">
              <div class="schedule-item__icon schedule-item__icon--cron">
                <q-icon name="event_repeat" size="18px" />
              </div>
              <div class="col min-width-zero">
                <div class="text-body2 text-weight-medium ellipsis">{{ cron.label || cron.expression }}</div>
                <div class="text-caption text-kobo-3">
                  {{ $t('schedule.nextFireAt', { time: formatDateTime(cron.nextFireAt) }) }}
                </div>
              </div>
              <q-btn
                flat
                dense
                round
                icon="delete_outline"
                size="sm"
                color="kobo-2"
                :title="$t('schedule.cancelCron')"
                @click="onCancelCron(cron.id)"
              />
            </div>
            <div class="row items-center q-gutter-xs q-mt-sm">
              <q-chip dense square color="blue-grey-9" text-color="kobo-2" size="sm">
                {{ cron.expression }}
              </q-chip>
              <span v-if="cron.lastFiredAt" class="text-caption text-kobo-3">
                {{ $t('schedule.lastFiredAt', { time: formatRelative(cron.lastFiredAt) }) }}
              </span>
            </div>
            <div class="prompt-preview schedule-item__prompt">{{ cron.prompt }}</div>
          </q-card-section>
        </q-card>
      </div>
    </section>

    <section>
      <div class="row items-center justify-between q-mb-sm">
        <div>
          <div class="text-subtitle2">{{ $t('schedule.createTitle') }}</div>
          <div class="text-caption text-kobo-3">{{ $t('schedule.createDescription') }}</div>
        </div>
      </div>

      <q-card dark flat bordered class="create-card">
        <q-btn-toggle
          v-model="createKind"
          spread
          no-caps
          unelevated
          toggle-color="primary"
          color="blue-grey-10"
          text-color="kobo-2"
          :options="createKindOptions"
          class="type-toggle"
        />

        <q-card-section v-if="createKind === 'wakeup'" class="column q-gutter-y-md">
          <div>
            <div class="text-body2 text-weight-medium">{{ $t('schedule.addWakeupTitle') }}</div>
            <div class="text-caption text-kobo-3">{{ $t('schedule.wakeupDescription') }}</div>
          </div>

          <q-input
            v-model.number="wakeupMinutes"
            type="number"
            dense
            dark
            outlined
            min="1"
            :label="$t('schedule.delayMinutes')"
          >
            <template #prepend><q-icon name="timer" size="18px" /></template>
          </q-input>
          <q-input
            v-model="wakeupPrompt"
            type="textarea"
            autogrow
            dense
            dark
            outlined
            :label="$t('schedule.promptLabel')"
            :hint="$t('schedule.promptHint')"
          />

          <div class="column q-gutter-y-xs">
            <div class="field-label">{{ $t('schedule.sessionModeTitle') }}</div>
            <q-btn-toggle
              v-model="wakeupSessionMode"
              spread
              no-caps
              unelevated
              toggle-color="blue-grey-7"
              color="transparent"
              text-color="kobo-2"
              :options="sessionModeOptions"
              class="session-toggle"
            />
          </div>

          <q-btn
            no-caps
            unelevated
            color="primary"
            icon="alarm_add"
            :loading="creatingWakeup"
            :disable="!wakeupPrompt.trim() || !(wakeupMinutes > 0)"
            :label="$t('schedule.addWakeupBtn')"
            class="full-width action-button"
            @click="onScheduleWakeup"
          />
        </q-card-section>

        <q-card-section v-else class="column q-gutter-y-md">
          <div>
            <div class="text-body2 text-weight-medium">{{ $t('schedule.addCronTitle') }}</div>
            <div class="text-caption text-kobo-3">{{ $t('schedule.cronDescription') }}</div>
          </div>

          <q-input v-model="cronLabel" dense dark outlined :label="$t('schedule.labelOptional')" />

          <div class="column q-gutter-y-xs">
            <div class="field-label">{{ $t('schedule.frequencyTitle') }}</div>
            <div class="row items-center no-wrap q-gutter-sm">
              <span class="text-body2 text-kobo-2">{{ $t('schedule.every') }}</span>
              <q-input v-model.number="cronN" type="number" dense dark outlined min="1" class="frequency-value" />
              <q-select
                v-model="cronUnit"
                :options="unitOptions"
                dense
                dark
                outlined
                options-dense
                emit-value
                map-options
                class="col min-width-zero"
              />
            </div>
            <div
              v-if="cronUnit === 'days' && cronDaysHasMonthBoundaryDrift(cronN)"
              class="text-caption text-warning"
            >
              {{ $t('schedule.daysDriftWarning') }}
            </div>
          </div>

          <q-input
            v-model="cronPrompt"
            type="textarea"
            autogrow
            dense
            dark
            outlined
            :label="$t('schedule.promptLabel')"
            :hint="$t('schedule.promptHint')"
          />

          <q-expansion-item
            dense
            dense-toggle
            switch-toggle-side
            icon="code"
            :label="$t('schedule.advancedExpression')"
            :caption="$t('schedule.advancedDescription')"
            class="advanced-section"
          >
            <q-input
              v-model="cronAdvanced"
              dense
              dark
              outlined
              :label="$t('schedule.cronExpressionLabel')"
              :hint="$t('schedule.advancedHint')"
              class="q-mt-sm"
            />
          </q-expansion-item>

          <div class="column q-gutter-y-xs">
            <div class="field-label">{{ $t('schedule.sessionModeTitle') }}</div>
            <q-btn-toggle
              v-model="cronSessionMode"
              spread
              no-caps
              unelevated
              toggle-color="blue-grey-7"
              color="transparent"
              text-color="kobo-2"
              :options="sessionModeOptions"
              class="session-toggle"
            />
          </div>

          <div class="one-shot-option row items-center justify-between no-wrap q-pa-sm">
            <div>
              <div class="text-body2">{{ $t('schedule.oneShot') }}</div>
              <div class="text-caption text-kobo-3">{{ $t('schedule.oneShotHint') }}</div>
            </div>
            <q-toggle v-model="cronOneShot" dense />
          </div>

          <q-btn
            no-caps
            unelevated
            color="primary"
            icon="add_task"
            :loading="creatingCron"
            :disable="!cronPrompt.trim()"
            :label="$t('schedule.addCronBtn')"
            class="full-width action-button"
            @click="onCreateCron"
          />
        </q-card-section>
      </q-card>
    </section>
  </div>
</template>

<script setup lang="ts">
import { useQuasar } from 'quasar'
import { useWorkspaceStore } from 'src/stores/workspace'
import { type CronUnit, cronDaysHasMonthBoundaryDrift, cronExpressionFromPicker } from 'src/utils/cron-expression'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ workspaceId: string }>()
const { t } = useI18n()
const $q = useQuasar()
const store = useWorkspaceStore()

const pendingWakeup = computed(() => store.pendingWakeups[props.workspaceId] ?? null)
const crons = computed(() => store.crons[props.workspaceId] ?? [])
const activeCount = computed(() => crons.value.length + (pendingWakeup.value ? 1 : 0))

watch(
  () => props.workspaceId,
  (id) => {
    if (id) void store.fetchCrons(id)
  },
  { immediate: true },
)

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatRelative(iso: string): string {
  const deltaMs = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(deltaMs) || deltaMs < 0) return '—'
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const seconds = Math.floor(deltaMs / 1000)
  if (seconds < 60) return formatter.format(-seconds, 'second')
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return formatter.format(-minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return formatter.format(-hours, 'hour')
  return formatter.format(-Math.floor(hours / 24), 'day')
}

async function cancelWakeup(): Promise<void> {
  try {
    const res = await fetch(`/api/workspaces/${props.workspaceId}/pending-wakeup`, { method: 'DELETE' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } catch (err) {
    $q.notify({ type: 'negative', message: String(err), position: 'top', timeout: 4000 })
  }
}

async function onCancelCron(id: string): Promise<void> {
  try {
    await store.cancelCron(props.workspaceId, id)
  } catch (err) {
    $q.notify({ type: 'negative', message: String(err), position: 'top', timeout: 4000 })
  }
}

// --- Create cron form ---
const createKind = ref<'wakeup' | 'cron'>('wakeup')
const cronN = ref(15)
const cronUnit = ref<CronUnit>('minutes')
const cronAdvanced = ref('')
const cronPrompt = ref('')
const cronLabel = ref('')
const cronSessionMode = ref<'fresh' | 'resume'>('fresh')
const cronOneShot = ref(false)
const creatingCron = ref(false)
const createKindOptions = computed(() => [
  { label: t('schedule.typeWakeup'), value: 'wakeup', icon: 'alarm' },
  { label: t('schedule.typeRecurring'), value: 'cron', icon: 'event_repeat' },
])
const sessionModeOptions = computed(() => [
  { label: t('schedule.modeFresh'), value: 'fresh', icon: 'add_comment' },
  { label: t('schedule.modeResume'), value: 'resume', icon: 'history' },
])
const unitOptions = computed(() => [
  { label: t('schedule.unitMinutes'), value: 'minutes' },
  { label: t('schedule.unitHours'), value: 'hours' },
  { label: t('schedule.unitDays'), value: 'days' },
])

async function onCreateCron(): Promise<void> {
  if (!cronPrompt.value.trim() || creatingCron.value) return
  creatingCron.value = true
  try {
    const expression = cronAdvanced.value.trim() || cronExpressionFromPicker(cronUnit.value, cronN.value)
    await store.createCron(props.workspaceId, {
      expression,
      prompt: cronPrompt.value,
      label: cronLabel.value.trim() || undefined,
      mode: cronSessionMode.value,
      oneShot: cronOneShot.value,
    })
    cronPrompt.value = ''
    cronLabel.value = ''
    cronAdvanced.value = ''
    $q.notify({ type: 'positive', message: t('schedule.cronCreated'), position: 'top', timeout: 2500 })
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: String(err instanceof Error ? err.message : err),
      position: 'top',
      timeout: 5000,
    })
  } finally {
    creatingCron.value = false
  }
}

// --- Schedule wakeup form ---
const wakeupMinutes = ref(15)
const wakeupPrompt = ref('')
const wakeupSessionMode = ref<'fresh' | 'resume'>('fresh')
const creatingWakeup = ref(false)

async function onScheduleWakeup(): Promise<void> {
  if (!wakeupPrompt.value.trim() || !(wakeupMinutes.value > 0) || creatingWakeup.value) return
  creatingWakeup.value = true
  try {
    await store.scheduleManualWakeup(props.workspaceId, {
      delaySeconds: Math.round(wakeupMinutes.value * 60),
      prompt: wakeupPrompt.value,
      mode: wakeupSessionMode.value,
    })
    wakeupPrompt.value = ''
    $q.notify({ type: 'positive', message: t('schedule.wakeupCreated'), position: 'top', timeout: 2500 })
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: String(err instanceof Error ? err.message : err),
      position: 'top',
      timeout: 5000,
    })
  } finally {
    creatingWakeup.value = false
  }
}
</script>

<style scoped lang="scss">
.schedule-header__icon {
  display: grid;
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
  place-items: center;
  border: 1px solid rgb(102 95 221 / 35%);
  border-radius: 10px;
  color: var(--kobo-text-2);
  background: rgb(102 95 221 / 12%);
}

.empty-state {
  border-style: dashed;
  background: rgb(255 255 255 / 1.5%);
}

.schedule-item {
  background: rgb(255 255 255 / 2.5%);
}

.schedule-item--wakeup {
  border-color: rgb(251 191 36 / 28%);
}

.schedule-item__icon {
  display: grid;
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  place-items: center;
  border-radius: 8px;
}

.schedule-item__icon--wakeup {
  color: var(--kobo-warning);
  background: rgb(251 191 36 / 12%);
}

.schedule-item__icon--cron {
  color: var(--kobo-accent);
  background: rgb(34 211 238 / 10%);
}

.schedule-item__prompt {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  color: var(--kobo-text-3);
  background: rgb(0 0 0 / 16%);
  font-size: 12px;
  line-height: 1.45;
}

.min-width-zero {
  min-width: 0;
}

.create-card {
  overflow: hidden;
  background: rgb(255 255 255 / 2.5%);
}

.type-toggle {
  padding: 6px;
  border-bottom: 1px solid rgb(255 255 255 / 9%);
  gap: 6px;
}

.type-toggle :deep(.q-btn) {
  min-height: 38px;
  border-radius: 7px;
}

.field-label {
  color: var(--kobo-text-2);
  font-size: 12px;
  font-weight: 500;
}

.frequency-value {
  width: 72px;
  flex: 0 0 72px;
}

.session-toggle {
  overflow: hidden;
  border: 1px solid rgb(255 255 255 / 14%);
  border-radius: 7px;
}

.session-toggle :deep(.q-btn) {
  min-height: 36px;
}

.advanced-section {
  border: 1px solid rgb(255 255 255 / 10%);
  border-radius: 7px;
  background: rgb(0 0 0 / 8%);
}

.advanced-section :deep(.q-expansion-item__content) {
  padding: 0 12px 12px;
}

.one-shot-option {
  border: 1px solid rgb(255 255 255 / 10%);
  border-radius: 7px;
}

.action-button {
  min-height: 40px;
}

.prompt-preview {
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}

</style>
