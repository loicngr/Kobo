<template>
  <q-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)">
    <q-card dark class="full-width">
      <q-card-section>
        <div class="text-subtitle1 text-kobo-1">{{ $t('updateTrigger.dialogTitle') }}</div>
      </q-card-section>
      <q-card-section v-if="trigger.step === 'idle'" class="column q-gutter-sm">
        <div class="text-kobo-2">{{ $t('updateTrigger.explain') }}</div>
        <div class="text-caption text-kobo-3">{{ $t('updateTrigger.signInAgain') }}</div>
        <q-checkbox v-model="backup" dark dense data-test="update-backup" :label="$t('updateTrigger.backup')" />
        <div v-if="!backup" class="text-caption text-warning">{{ $t('updateTrigger.backupWarning') }}</div>
        <template v-if="busy">
          <div v-if="runningAgents > 0" class="text-warning">
            {{ $t('updateTrigger.agentsRunning', { count: runningAgents }) }}
          </div>
          <div v-else class="text-warning">{{ $t('updateTrigger.workspaceMarkedRunning') }}</div>
          <q-checkbox
            v-model="stopAgents"
            dark
            dense
            data-test="update-stop-agents"
            :label="$t('updateTrigger.stopAgents')"
          />
        </template>
      </q-card-section>
      <q-card-section v-else>
        <UpdateTriggerProgress @dismiss="emit('update:modelValue', false)" />
      </q-card-section>
      <q-card-section v-if="error" class="q-pt-none">
        <div class="text-warning" role="alert">{{ error }}</div>
      </q-card-section>
      <q-card-actions align="right">
        <template v-if="trigger.step === 'idle'">
          <q-btn flat no-caps color="kobo-2" :label="$t('common.cancel')" @click="emit('update:modelValue', false)" />
          <ActionAvailability :reason="blocked ? $t('updateTrigger.stopAgentsWarning') : null">
            <q-btn
              unelevated
              no-caps
              color="primary"
              data-test="update-confirm"
              :label="$t('updateTrigger.confirm')"
              :disable="blocked || starting"
              :loading="starting"
              @click="confirm"
            />
          </ActionAvailability>
        </template>
        <q-btn
          v-else-if="!trigger.finished"
          flat
          no-caps
          color="kobo-2"
          :label="$t('common.close')"
          @click="emit('update:modelValue', false)"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>
<script setup lang="ts">
import ActionAvailability from 'src/components/ActionAvailability.vue'
import UpdateTriggerProgress from 'src/components/UpdateTriggerProgress.vue'
import { REASON_KEY, useUpdateTriggerStore } from 'src/stores/update-trigger'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const { t } = useI18n()
const trigger = useUpdateTriggerStore()

const backup = ref(true)
const stopAgents = ref(false)
const starting = ref(false)
const error = ref<string | null>(null)

const runningAgents = computed(() => trigger.state?.runningAgents ?? 0)
// The server's reservation rule: live agents, but also a workspace still marked running without one.
const busy = computed(() => trigger.state?.busy === true)
const blocked = computed(() => busy.value && !stopAgents.value)

// The dialog stays mounted: a consent given in an earlier opening must never carry over.
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    backup.value = true
    stopAgents.value = false
    error.value = null
  },
)

// A foreign update that comes and goes while the dialog stays open must not leave an old consent behind.
watch(
  () => trigger.step,
  (step) => {
    if (step === 'idle') {
      error.value = null
      return
    }
    backup.value = true
    stopAgents.value = false
  },
)

async function failureText(err: unknown): Promise<string> {
  const code = (err as { code?: string }).code
  if (code === 'busy') return t(REASON_KEY.busy)
  if (code === 'pending' || code === 'in-progress') return t(REASON_KEY['already-running'])
  if (code === 'unavailable') return t('updateTrigger.error.unavailable')
  if (code) return t(REASON_KEY.unknown)
  // No answer: the request may have been accepted anyway, so look before claiming anything.
  await trigger.refresh()
  const server = trigger.state
  return t(server?.pending || server?.inProgress ? REASON_KEY['already-running'] : 'updateTrigger.error.network')
}

async function confirm(): Promise<void> {
  starting.value = true
  error.value = null
  try {
    await trigger.start({ skipBackup: !backup.value, stopAgents: busy.value && stopAgents.value })
  } catch (err) {
    error.value = await failureText(err)
  } finally {
    starting.value = false
  }
}
</script>
