<template>
  <div class="schedule-panel column q-pa-md q-gutter-md">
    <!-- Wakeup section -->
    <div>
      <div class="text-subtitle2 q-mb-sm">{{ $t('schedule.wakeupTitle') }}</div>
      <div v-if="!pendingWakeup" class="text-caption text-grey-7">{{ $t('schedule.noWakeup') }}</div>
      <q-card v-else dark flat bordered>
        <q-card-section class="q-py-sm">
          <div class="row items-center no-wrap">
            <q-icon name="schedule" size="16px" color="amber-4" class="q-mr-sm" />
            <div class="text-body2">{{ formatTime(pendingWakeup.targetAt) }}</div>
            <q-space />
            <q-btn flat dense round icon="close" size="sm" :title="$t('common.cancel')" @click="cancelWakeup" />
          </div>
          <pre v-if="pendingWakeup.reason" class="text-caption text-grey-6 q-mt-xs prompt-preview">{{ pendingWakeup.reason }}</pre>
        </q-card-section>
      </q-card>
    </div>

    <!-- Crons section -->
    <div>
      <div class="text-subtitle2 q-mb-sm">{{ $t('schedule.cronsTitle') }}</div>
      <div v-if="crons.length === 0" class="text-caption text-grey-7">{{ $t('schedule.noCrons') }}</div>
      <q-list v-else dense dark separator>
        <q-item v-for="cron in crons" :key="cron.id">
          <q-item-section>
            <div class="row items-center no-wrap">
              <q-icon name="event_repeat" size="16px" color="cyan-4" class="q-mr-sm" />
              <div class="text-body2 ellipsis">{{ cron.label || cron.expression }}</div>
            </div>
            <div class="text-caption text-grey-6 q-mt-xs">
              {{ $t('schedule.nextFireAt', { time: formatTime(cron.nextFireAt) }) }}
              <span v-if="cron.lastFiredAt"> · {{ $t('schedule.lastFiredAt', { time: formatRelative(cron.lastFiredAt) }) }}</span>
            </div>
            <pre class="prompt-preview text-caption text-grey-6 q-mt-xs">{{ cron.prompt }}</pre>
          </q-item-section>
          <q-item-section side top>
            <q-btn flat dense round icon="close" size="sm" :title="$t('common.cancel')" @click="onCancelCron(cron.id)" />
          </q-item-section>
        </q-item>
      </q-list>
    </div>

    <q-separator dark />

    <!-- Create cron -->
    <div>
      <div class="text-subtitle2 q-mb-sm">{{ $t('schedule.addCronTitle') }}</div>
      <div class="row items-center q-gutter-sm q-mb-sm">
        <span class="text-caption text-grey-6">{{ $t('schedule.every') }}</span>
        <q-input v-model.number="cronN" type="number" dense dark outlined min="1" style="width: 72px" />
        <q-select
          v-model="cronUnit"
          :options="unitOptions"
          dense dark outlined options-dense emit-value map-options
          style="min-width: 110px"
        />
      </div>
      <q-input
        v-model="cronAdvanced"
        dense dark outlined
        :label="$t('schedule.advancedExpression')"
        :hint="$t('schedule.advancedHint')"
        class="q-mb-sm"
      />
      <q-input v-model="cronPrompt" type="textarea" autogrow dense dark outlined :label="$t('schedule.promptLabel')" class="q-mb-sm" />
      <q-input v-model="cronLabel" dense dark outlined :label="$t('schedule.labelOptional')" class="q-mb-sm" />
      <div class="row items-center q-gutter-md q-mb-sm">
        <q-toggle v-model="cronNewSession" dense :label="$t('schedule.modeFresh')" />
        <q-toggle v-model="cronOneShot" dense :label="$t('schedule.oneShot')" />
      </div>
      <q-btn dense no-caps color="indigo-4" :loading="creatingCron" :disable="!cronPrompt.trim()" :label="$t('schedule.addCronBtn')" @click="onCreateCron" />
    </div>

    <q-separator dark />

    <!-- Schedule wakeup -->
    <div>
      <div class="text-subtitle2 q-mb-sm">{{ $t('schedule.addWakeupTitle') }}</div>
      <q-input v-model.number="wakeupMinutes" type="number" dense dark outlined min="1" :label="$t('schedule.delayMinutes')" style="max-width: 160px" class="q-mb-sm" />
      <q-input v-model="wakeupPrompt" type="textarea" autogrow dense dark outlined :label="$t('schedule.promptLabel')" class="q-mb-sm" />
      <q-toggle v-model="wakeupNewSession" dense :label="$t('schedule.modeFresh')" class="q-mb-sm" />
      <div>
        <q-btn dense no-caps color="indigo-4" :loading="creatingWakeup" :disable="!wakeupPrompt.trim() || !(wakeupMinutes > 0)" :label="$t('schedule.addWakeupBtn')" @click="onScheduleWakeup" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useQuasar } from 'quasar'
import { useWorkspaceStore } from 'src/stores/workspace'
import { type CronUnit, cronExpressionFromPicker } from 'src/utils/cron-expression'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ workspaceId: string }>()
const { t } = useI18n()
const $q = useQuasar()
const store = useWorkspaceStore()

const pendingWakeup = computed(() => store.pendingWakeups[props.workspaceId] ?? null)
const crons = computed(() => store.crons[props.workspaceId] ?? [])

watch(
  () => props.workspaceId,
  (id) => {
    if (id) void store.fetchCrons(id)
  },
  { immediate: true },
)

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function formatRelative(iso: string): string {
  const deltaMs = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(deltaMs) || deltaMs < 0) return '—'
  const s = Math.floor(deltaMs / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
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
const cronN = ref(15)
const cronUnit = ref<CronUnit>('minutes')
const cronAdvanced = ref('')
const cronPrompt = ref('')
const cronLabel = ref('')
const cronNewSession = ref(true) // ON = new session (fresh) — the default
const cronOneShot = ref(false)
const creatingCron = ref(false)
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
      mode: cronNewSession.value ? 'fresh' : 'resume',
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
const wakeupNewSession = ref(true) // ON = new session (fresh) — the default
const creatingWakeup = ref(false)

async function onScheduleWakeup(): Promise<void> {
  if (!wakeupPrompt.value.trim() || !(wakeupMinutes.value > 0) || creatingWakeup.value) return
  creatingWakeup.value = true
  try {
    await store.scheduleManualWakeup(props.workspaceId, {
      delaySeconds: Math.round(wakeupMinutes.value * 60),
      prompt: wakeupPrompt.value,
      mode: wakeupNewSession.value ? 'fresh' : 'resume',
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

// Suppress unused warning — `t` is used in the template via $t but tsc strict
// may flag it.
void t
</script>

<style scoped lang="scss">
.prompt-preview {
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}
</style>
