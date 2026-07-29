<template>
  <div v-if="pending" class="ask-user-question-panel q-pa-sm bg-dark text-grey-3" :class="{ collapsed }">
    <div class="row items-center q-mb-xs">
      <q-icon name="question_answer" size="16px" color="amber-4" class="q-mr-sm" />
      <div class="text-caption text-uppercase text-weight-bold text-amber-4" style="letter-spacing: 0.05em;">
        {{ t('askUserQuestion.title') }}
      </div>
      <q-space />
      <span v-if="questions.length > 1" class="text-caption text-grey-6 q-mr-sm">
        {{ stepIndex + 1 }} / {{ questions.length }}
      </span>
      <q-btn
        :icon="collapsed ? 'expand_more' : 'expand_less'"
        flat
        dense
        size="sm"
        color="grey-4"
        :aria-label="t(collapsed ? 'askUserQuestion.expand' : 'askUserQuestion.collapse')"
        @click="collapsed = !collapsed"
      >
        <q-tooltip>{{ t(collapsed ? 'askUserQuestion.expand' : 'askUserQuestion.collapse') }}</q-tooltip>
      </q-btn>
    </div>

    <q-stepper
      v-if="currentQuestion"
      v-show="!collapsed"
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
              v-model="answers[answerKey(q)]"
              :val="opt.label"
              dark
              dense
              color="indigo-4"
              :disable="submitting"
            >
              <template #default>
                <AukqOptionLabel :label="opt.label" :description="opt.description" :preview="opt.preview" />
              </template>
            </q-checkbox>
          </template>
          <template v-else>
            <q-radio
              v-for="opt in q.options"
              :key="opt.label"
              v-model="singleAnswers[answerKey(q)]"
              :val="opt.label"
              dark
              dense
              color="indigo-4"
              :disable="submitting"
            >
              <template #default>
                <AukqOptionLabel :label="opt.label" :description="opt.description" :preview="opt.preview" />
              </template>
            </q-radio>
          </template>
        </div>
        <q-input
          v-if="questionHasOtherSelection(q)"
          v-model="freeFormResponse"
          type="textarea"
          dark
          dense
          outlined
          autogrow
          class="q-mt-sm"
          :label="t('askUserQuestion.freeFormLabel')"
          :hint="t('askUserQuestion.freeFormHint')"
          :disable="submitting"
        />
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
import AukqOptionLabel from 'src/components/AukqOptionLabel.vue'
import { useWorkspaceStore } from 'src/stores/workspace'
import { expandOtherAnswerWithResponse, hasOtherSelection, OTHER_OPTION_VALUE } from 'src/utils/expand-other-answer'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

interface QuestionOption {
  label: string
  description?: string
  preview?: string
}
interface Question {
  id?: string
  question: string
  header?: string
  options: QuestionOption[]
  isOther?: boolean
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
  const raw = input?.questions ?? []
  return raw.map((q) => ({
    ...q,
    options: q.isOther === false ? [...(q.options ?? [])] : [...(q.options ?? []), { label: OTHER_OPTION_VALUE }],
  }))
})

function answerKey(question: Question): string {
  return question.id ?? question.question
}

const currentQuestion = computed(() => questions.value[stepIndex.value])

// For multi-select questions: array of selected labels.
const answers = ref<Record<string, string[]>>({})
// For single-select questions: scalar selected label.
const singleAnswers = ref<Record<string, string>>({})
const freeFormResponse = ref('')
const submitting = ref(false)
const error = ref<string | null>(null)
const stepIndex = ref(0)
const collapsed = ref(false)

watch(
  questions,
  (qs) => {
    answers.value = Object.fromEntries(qs.map((q) => [answerKey(q), []]))
    singleAnswers.value = Object.fromEntries(qs.map((q) => [answerKey(q), '']))
    freeFormResponse.value = ''
    error.value = null
    stepIndex.value = 0
    submitting.value = false
    collapsed.value = false
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
  const selected = q.multiSelect ? (answers.value[answerKey(q)] ?? []) : (singleAnswers.value[answerKey(q)] ?? '')
  if (Array.isArray(selected) ? selected.length === 0 : !selected) return false
  return !hasOtherSelection([selected]) || freeFormResponse.value.trim().length > 0
}

function questionHasOtherSelection(question: Question): boolean {
  const selected = question.multiSelect
    ? (answers.value[answerKey(question)] ?? [])
    : (singleAnswers.value[answerKey(question)] ?? '')
  return hasOtherSelection([selected])
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
    const hasFreeFormSelection = questions.value.some(questionHasOtherSelection)
    for (const q of questions.value) {
      if (q.multiSelect) {
        const sel = answers.value[answerKey(q)] ?? []
        payload[answerKey(q)] = expandOtherAnswerWithResponse(sel, true, freeFormResponse.value)
      } else {
        const sel = singleAnswers.value[answerKey(q)] ?? ''
        payload[answerKey(q)] = expandOtherAnswerWithResponse(sel, false, freeFormResponse.value)
      }
    }
    await store.submitDeferredAnswer(
      props.workspaceId,
      payload,
      pending.value?.toolCallId,
      false,
      hasFreeFormSelection ? freeFormResponse.value.trim() : undefined,
    )
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
.ask-user-question-panel.collapsed {
  max-height: none;
  overflow-y: visible;
}
.ask-user-question-panel.collapsed .row {
  margin-bottom: 0;
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
