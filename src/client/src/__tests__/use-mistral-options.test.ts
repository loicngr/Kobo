import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { defineComponent, reactive } from 'vue'
import { createI18n } from 'vue-i18n'
import { useMistralOptions } from '../composables/use-mistral-options'
import en from '../i18n/en'

const fetch = vi.hoisted(() => vi.fn())
vi.mock('../utils/api', () => ({ apiFetch: fetch }))
const options = (model: string, efforts: string[]) => ({
  model: { currentValue: model, options: [{ value: model, name: `Native ${model}` }] },
  thinking: { currentValue: efforts[0], options: efforts.map((value) => ({ value, name: `Native ${value}` })) },
})
function deferred() {
  let resolve!: (value: unknown) => void
  let reject!: (error: Error) => void
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { resolve, reject, promise }
}
afterEach(() => vi.resetAllMocks())
it('uses model-specific native labels, preserves unavailable values and ignores late context responses/errors', async () => {
  const first = deferred()
  const second = deferred()
  const third = deferred()
  fetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise)
  const selection = reactive({
    engine: 'mistral-vibe',
    projectPath: '/first',
    model: 'a',
    reasoningEffort: 'off',
    agentPermissionMode: 'interactive',
    enabled: true,
  })
  let state!: ReturnType<typeof useMistralOptions>
  const view = mount(
    defineComponent({
      setup() {
        state = useMistralOptions(() => selection)
        return () => null
      },
    }),
    { global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] } },
  )
  selection.model = 'b'
  second.resolve(options('b', ['off', 'max']))
  await flushPromises()
  expect(state.models.map((item) => item.label)).toContain('Native b')
  expect(state.efforts.map((item) => item.value)).toEqual(['auto', 'off', 'max'])
  first.reject(new Error('late failure'))
  await flushPromises()
  expect(state.message).toBe('')
  selection.projectPath = '/second'
  selection.reasoningEffort = 'removed'
  third.resolve(options('b', ['low']))
  await flushPromises()
  expect(state.efforts.at(-1)).toMatchObject({ value: 'removed', disable: true })
  expect(selection.reasoningEffort).toBe('removed')
  expect(state.message).toContain('Saved selection unavailable')
  const late = deferred()
  fetch.mockReturnValueOnce(late.promise)
  selection.model = 'c'
  selection.enabled = false
  late.resolve(options('c', ['high']))
  await flushPromises()
  expect(state.models.map((item) => item.label)).not.toContain('Native c')
  expect(state.loading).toBe(false)
  view.unmount()
})
it('discovers the catalogue for unsupported Plan without changing permissions and leaves Auto usable on error', async () => {
  fetch.mockRejectedValue(new Error('unavailable'))
  const selection = reactive({ engine: 'claude-code', model: 'auto', agentPermissionMode: 'interactive' })
  let state!: ReturnType<typeof useMistralOptions>
  const view = mount(
    defineComponent({
      setup() {
        state = useMistralOptions(() => selection)
        return () => null
      },
    }),
    { global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] } },
  )
  expect(fetch).not.toHaveBeenCalled()
  selection.agentPermissionMode = 'plan'
  selection.engine = 'mistral-vibe'
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('agentPermissionMode=interactive'), expect.anything())
  expect(selection.agentPermissionMode).toBe('plan')
  selection.agentPermissionMode = 'interactive'
  await flushPromises()
  expect(state.models).toContainEqual(expect.objectContaining({ value: 'auto', disable: false }))
  expect(state.message).toContain('Native options unavailable')
  view.unmount()
})

it('does not declare a saved alias unavailable before successful catalogue discovery and allows retry', async () => {
  const pending = deferred()
  fetch.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(options('saved-alias', ['off']))
  const selection = reactive({
    engine: 'mistral-vibe',
    model: 'saved-alias',
    agentPermissionMode: 'plan',
    enabled: false,
  })
  let state!: ReturnType<typeof useMistralOptions>
  const view = mount(
    defineComponent({
      setup() {
        state = useMistralOptions(() => selection)
        return () => null
      },
    }),
    { global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] } },
  )
  expect(state.models.at(-1)?.description).not.toBe(en['engine.mistralSelectionUnavailable'])
  selection.enabled = true
  expect(state.loading).toBe(true)
  expect(state.models.at(-1)?.description).not.toBe(en['engine.mistralSelectionUnavailable'])
  pending.reject(new Error('unavailable'))
  await flushPromises()
  expect(state.message).toBe(en['engine.mistralOptionsError'])
  expect(state.models.at(-1)?.description).not.toBe(en['engine.mistralSelectionUnavailable'])
  await state.refresh()
  expect(state.models.at(-1)).toMatchObject({ label: 'Native saved-alias', disable: false })
  expect(state.message).toBe('')
  expect(selection.agentPermissionMode).toBe('plan')
  view.unmount()
})
