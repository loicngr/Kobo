<template>
  <div
    v-if="visible"
    class="quota-backoff-banner row items-center q-px-md q-py-sm"
    style="background-color: #b87333; color: #f0f0f0;"
  >
    <q-icon name="hourglass_top" size="18px" class="q-mr-sm" />
    <span class="text-body2">{{ t('quotaBackoff.banner.title', { time: formattedTime }) }}</span>
    <q-tooltip v-if="pending?.resetsAt">
      {{ t('quotaBackoff.banner.tooltip', { resets_at: formattedResetsAt }) }}
    </q-tooltip>
    <q-space />
    <q-btn
      flat dense no-caps size="sm" color="grey-3"
      :label="t('quotaBackoff.banner.cancel')"
      :loading="cancelling"
      @click="onCancel"
    />
  </div>
</template>

<script setup lang="ts">
import { useQuasar } from 'quasar'
import { useWorkspaceStore } from 'src/stores/workspace'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ workspaceId: string }>()
const { t } = useI18n()
const $q = useQuasar()
const store = useWorkspaceStore()
const cancelling = ref(false)

const pending = computed(() => store.pendingQuotaBackoffs[props.workspaceId])
const ws = computed(() => store.workspaces.find((w) => w.id === props.workspaceId))
const autoLoopState = computed(() => store.autoLoopStates[props.workspaceId])

const visible = computed(
  () => ws.value?.status === 'quota' && autoLoopState.value?.auto_loop === true && pending.value !== undefined,
)

const formattedTime = computed(() => {
  const target = pending.value?.targetAt
  if (!target) return ''
  return new Date(target).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
})

const formattedResetsAt = computed(() => {
  const r = pending.value?.resetsAt
  if (!r) return ''
  return new Date(r).toLocaleString()
})

async function onCancel(): Promise<void> {
  if (cancelling.value) return
  cancelling.value = true
  try {
    await store.cancelQuotaBackoff(props.workspaceId)
    $q.notify({ type: 'info', message: t('quotaBackoff.cancelled'), position: 'top', timeout: 4000 })
  } catch (err) {
    $q.notify({ type: 'negative', message: String(err), position: 'top', timeout: 4000 })
  } finally {
    cancelling.value = false
  }
}
</script>
