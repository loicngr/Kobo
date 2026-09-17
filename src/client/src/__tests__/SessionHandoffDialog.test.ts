import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import type { SessionHandoffRequest } from '../../../shared/session-handoff'
import SessionHandoffDialog from '../components/SessionHandoffDialog.vue'
import en from '../i18n/en'
import type { Workspace } from '../stores/workspace'

const workspace = {
  id: 'ws-1',
  engine: 'codex',
  model: 'gpt-5.4',
  reasoningEffort: 'high',
  agentPermissionMode: 'bypass',
} as Workspace
const global = {
  plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
  stubs: {
    QDialog: { props: ['modelValue'], template: '<div v-if="modelValue"><slot /></div>' },
    QCard: { template: '<div><slot /></div>' },
    QCardSection: { template: '<div><slot /></div>' },
    QCardActions: { template: '<div><slot /></div>' },
    QSeparator: true,
    QBtn: {
      props: ['label', 'disable', 'loading'],
      template: '<button :disabled="disable || loading">{{ label }}</button>',
    },
    QSelect: {
      props: ['modelValue', 'options', 'disable'],
      emits: ['update:modelValue'],
      template:
        '<select :value="modelValue" :disabled="disable" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="option in options" :value="option.value" :disabled="option.disable">{{ option.label }}</option></select>',
    },
    QToggle: {
      props: ['modelValue', 'label'],
      emits: ['update:modelValue'],
      template:
        '<label><input type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" />{{ label }}</label>',
    },
  },
}
const mountDialog = (mode: 'fresh' | 'switch' = 'fresh') =>
  mount(SessionHandoffDialog, {
    props: { modelValue: true, workspace, sourceSessionId: 'source', mode, loading: false },
    global,
  })
beforeEach(() => setActivePinia(createPinia()))
afterEach(() => vi.unstubAllGlobals())

it('defaults to the workspace configuration and generated passation, with immediate interruption explained', async () => {
  const view = mountDialog()
  expect((view.get('input').element as HTMLInputElement).checked).toBe(true)
  expect(view.text()).toContain('immediately')
  expect(view.text()).toContain('automatically')
  await view.get('[data-test="handoff-submit"]').trigger('click')
  expect(view.emitted('submit')?.[0]?.[0]).toMatchObject({
    sourceSessionId: 'source',
    generateSummary: true,
    target: { engine: 'codex', model: 'gpt-5.4', reasoningEffort: 'high', agentPermissionMode: 'bypass' },
  })
  view.unmount()
})

it('allows changing the model on the same engine without asking the source LLM', async () => {
  const view = mountDialog('switch')
  const engineSelect = view.get('[data-test="handoff-engine"]')
  expect(engineSelect.findAll('option').every((option) => option.attributes('disabled') === undefined)).toBe(true)
  await engineSelect.setValue('codex')
  await view.get('[data-test="handoff-model"]').setValue('auto')
  await view.get('input').setValue(false)
  await view.get('[data-test="handoff-submit"]').trigger('click')
  const request = view.emitted('submit')?.[0]?.[0] as SessionHandoffRequest
  expect(request.generateSummary).toBe(false)
  expect(request.target).toMatchObject({ engine: 'codex', model: 'auto' })
  view.unmount()
})

it('pins the source selected when the dialog opened and reuses the request key for identical retries', async () => {
  const view = mountDialog()
  await view.setProps({ sourceSessionId: 'new-current' })
  await view.get('[data-test="handoff-submit"]').trigger('click')
  await view.get('[data-test="handoff-submit"]').trigger('click')
  const requests = view.emitted('submit')!.map((event) => event[0] as SessionHandoffRequest)
  expect(requests[0]!.sourceSessionId).toBe('source')
  expect(requests[1]!.requestId).toBe(requests[0]!.requestId)
  await view.get('input').setValue(false)
  await view.get('[data-test="handoff-submit"]').trigger('click')
  expect((view.emitted('submit')![2]![0] as SessionHandoffRequest).requestId).not.toBe(requests[0]!.requestId)
  view.unmount()
})

it('creates an idempotency key on HTTP network origins without crypto.randomUUID', async () => {
  vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
  const view = mountDialog()
  await view.get('[data-test="handoff-submit"]').trigger('click')
  expect((view.emitted('submit')?.[0]?.[0] as SessionHandoffRequest)?.requestId).toMatch(/^[a-f0-9-]{16,}$/)
  view.unmount()
})
