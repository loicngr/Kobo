<template>
  <div v-if="pending" class="ask-user-question-panel q-pa-sm bg-dark text-grey-3">
    <div class="row items-center q-mb-xs">
      <q-icon name="question_answer" size="16px" color="amber-4" class="q-mr-sm" />
      <div class="text-caption text-uppercase text-weight-bold text-amber-4" style="letter-spacing: 0.05em;">
        {{ t('askUserQuestion.title') }}
      </div>
      <q-space />
      <span v-if="questions.length > 1" class="text-caption text-grey-6">
        {{ stepIndex + 1 }} / {{ questions.length }}
      </span>
    </div>

    <q-stepper
      v-if="currentQuestion"
      ref="stepperRef"
      v-model="stepIndex"
      flat
      dark
      animated
      header-nav
      class="aukq-stepper bg-transparent"
      color="amber-5"
      active-color="amber-4"
      done-color="amber-5"
    >
      <q-step
        v-for="(q, qIdx) in questions"
        :key="qIdx"
        :name="qIdx"
        :title="stepTitle(q, qIdx)"
        :icon="stepIcon(qIdx)"
        :active-icon="'edit'"
        :done="stepDone(qIdx)"
        :header-nav="stepDone(qIdx) || qIdx === stepIndex"
      >
        <div class="text-body2 text-grey-2 q-mb-sm">{{ q.question }}</div>
        <div v-if="q.multiSelect" class="text-caption text-grey-6 q-mb-xs">
          {{ t('askUserQuestion.multiSelectHint') }}
        </div>
        <div class="aukq-options column q-gutter-xs">
          <template v-if="q.multiSelect">
            <q-checkbox
              v-for="opt in q.options"
              :key="opt.label"
              v-model="answers[q.question]"
              :val="opt.label"
              dark
              dense
              color="indigo-4"
              :disable="submitting"
            >
              <template #default>
                <span class="text-grey-3">{{ opt.label }}</span>
                <span v-if="opt.description" class="text-grey-6 q-ml-xs">— {{ opt.description }}</span>
              </template>
            </q-checkbox>
          </template>
          <template v-else>
            <q-radio
              v-for="opt in q.options"
              :key="opt.label"
              v-model="singleAnswers[q.question]"
              :val="opt.label"
              dark
              dense
              color="indigo-4"
              :disable="submitting"
            >
              <template #default>
                <span class="text-grey-3">{{ opt.label }}</span>
                <span v-if="opt.description" class="text-grey-6 q-ml-xs">— {{ opt.description }}</span>
              </template>
            </q-radio>
          </template>
        </div>
      </q-step>

      <template #navigation>
        <q-stepper-navigation>
          <div class="row items-center q-gutter-sm">
            <q-btn
              v-if="stepIndex > 0"
              flat
              dense
              color="grey-4"
              :label="t('askUserQuestion.previous')"
              :disable="submitting"
              @click="goPrev"
            />
            <q-btn
              v-if="!isLast"
              :label="t('askUserQuestion.next')"
              color="indigo-5"
              dense
              unelevated
              :disable="!stepFilled(stepIndex) || submitting"
              @click="goNext"
            />
            <q-btn
              v-else
              :label="t('askUserQuestion.submit')"
              color="indigo-5"
              dense
              unelevated
              :loading="submitting"
              :disable="!allFilled || submitting"
              @click="submit"
            />
            <q-btn
              :label="t('askUserQuestion.cancel')"
              flat
              dense
              color="grey-4"
              :disable="submitting"
              @click="cancel"
            >
              <q-tooltip>{{ t('askUserQuestion.cancelTooltip') }}</q-tooltip>
            </q-btn>
            <q-space />
            <span v-if="error" class="text-negative text-caption">{{ error }}</span>
          </div>
        </q-stepper-navigation>
      </template>
    </q-stepper>
  </div>
</template>

<script setup lang="ts">
import { useWorkspaceStore } from 'src/stores/workspace'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

interface QuestionOption {
  label: string
  description?: string
}
interface Question {
  question: string
  header?: string
  options: QuestionOption[]
  multiSelect?: boolean
}

const props = defineProps<{ workspaceId: string }>()
const { t } = useI18n()
const store = useWorkspaceStore()

// Render only when the head is a question — permission heads are handled by
// the sibling PermissionRequestPanel.
const pending = computed(() => {
  const head = store.peekPending(props.workspaceId)
  if (!head || head.kind !== 'question') return undefined
  return head
})

const questions = computed<Question[]>(() => {
  if (!pending.value) return []
  const input = pending.value.input as { questions?: Question[] } | undefined
  return input?.questions ?? []
})

const currentQuestion = computed(() => questions.value[stepIndex.value])

// For multi-select questions: array of selected labels.
const answers = ref<Record<string, string[]>>({})
// For single-select questions: scalar selected label.
const singleAnswers = ref<Record<string, string>>({})
const submitting = ref(false)
const error = ref<string | null>(null)
const stepIndex = ref(0)

watch(
  questions,
  (qs) => {
    answers.value = Object.fromEntries(qs.map((q) => [q.question, []]))
    singleAnswers.value = Object.fromEntries(qs.map((q) => [q.question, '']))
    error.value = null
    stepIndex.value = 0
    submitting.value = false
  },
  { immediate: true },
)

function stepTitle(q: Question, idx: number): string {
  if (q.header) return q.header
  return `Q${idx + 1}`
}

function stepIcon(idx: number): string {
  if (stepDone(idx)) return 'check'
  return 'help_outline'
}

function stepFilled(idx: number): boolean {
  const q = questions.value[idx]
  if (!q) return false
  if (q.multiSelect) return (answers.value[q.question] ?? []).length > 0
  return !!singleAnswers.value[q.question]
}

function stepDone(idx: number): boolean {
  return stepFilled(idx) && idx < stepIndex.value
}

const isLast = computed(() => stepIndex.value === questions.value.length - 1)
const allFilled = computed(() => questions.value.every((_, idx) => stepFilled(idx)))

function goNext(): void {
  if (stepIndex.value < questions.value.length - 1) stepIndex.value += 1
}

function goPrev(): void {
  if (stepIndex.value > 0) stepIndex.value -= 1
}

async function submit(): Promise<void> {
  if (submitting.value) return
  submitting.value = true
  error.value = null
  try {
    const payload: Record<string, string> = {}
    for (const q of questions.value) {
      if (q.multiSelect) {
        payload[q.question] = (answers.value[q.question] ?? []).join(', ')
      } else {
        payload[q.question] = singleAnswers.value[q.question] ?? ''
      }
    }
    await store.submitDeferredAnswer(props.workspaceId, payload, pending.value?.toolCallId)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    submitting.value = false
  }
}

async function cancel(): Promise<void> {
  if (submitting.value) return
  submitting.value = true
  error.value = null
  try {
    await store.cancelDeferredAnswer(
      props.workspaceId,
      'User cancelled the question via the UI',
      pending.value?.toolCallId,
    )
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.ask-user-question-panel {
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  max-height: 38vh;
  overflow-y: auto;
}
.aukq-stepper :deep(.q-stepper__header) {
  min-height: 56px;
}
.aukq-stepper :deep(.q-stepper__tab) {
  padding: 8px 12px;
}
.aukq-stepper :deep(.q-stepper__title) {
  font-size: 12px;
  white-space: nowrap;
}
.aukq-stepper :deep(.q-stepper__caption) {
  display: none;
}
.aukq-stepper :deep(.q-stepper__step-inner) {
  padding: 12px;
}
.aukq-stepper :deep(.q-stepper__nav) {
  padding-top: 8px;
}
.aukq-options {
  margin-bottom: 4px;
}
</style>
