<template>
  <q-dialog v-model="open" @hide="$emit('close')">
    <q-card dark style="min-width: 460px; max-width: 640px;">
      <q-card-section>
        <div class="text-subtitle1 text-grey-3">{{ $t('diff.compareTitle') }}</div>
      </q-card-section>
      <q-card-section class="q-gutter-md">
        <q-select
          v-model="fromRef"
          dark
          dense
          options-dense
          emit-value
          map-options
          :options="fromOptions"
          :label="$t('diff.compareFrom')"
        />
        <q-select
          v-model="toRef"
          dark
          dense
          options-dense
          emit-value
          map-options
          :options="toOptions"
          :label="$t('diff.compareTo')"
        />
      </q-card-section>
      <q-card-actions align="right">
        <q-btn flat no-caps :label="$t('common.cancel')" color="grey-5" @click="open = false" />
        <q-btn
          unelevated
          no-caps
          color="primary"
          :label="$t('diff.compareSubmit')"
          :disable="!fromRef || !toRef || fromRef === toRef"
          @click="submit"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { BranchCommit } from '../stores/workspace'

const props = defineProps<{
  modelValue: boolean
  commits: BranchCommit[]
  sourceBranch: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  compare: [payload: { from: string; to: string }]
  close: []
}>()

const { t } = useI18n()

const open = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

const commitOptions = computed(() => props.commits.map((c) => ({ label: `${c.shortSha}  ${c.subject}`, value: c.sha })))
// `From` also offers the source-branch tip as the oldest base.
const baseOption = computed(() => ({
  label: t('diff.compareSourceBase', { branch: props.sourceBranch }),
  value: `origin/${props.sourceBranch}`,
}))
const fromOptions = computed(() => [...commitOptions.value, baseOption.value])
const toOptions = computed(() => commitOptions.value)

const fromRef = ref<string>('')
const toRef = ref<string>('')

// Sensible defaults when the dialog opens: From = source base, To = newest commit.
watch(
  () => props.modelValue,
  (isOpen) => {
    if (!isOpen) return
    fromRef.value = baseOption.value.value
    toRef.value = props.commits[0]?.sha ?? ''
  },
)

function submit() {
  if (!fromRef.value || !toRef.value || fromRef.value === toRef.value) return
  emit('compare', { from: fromRef.value, to: toRef.value })
  open.value = false
}
</script>
