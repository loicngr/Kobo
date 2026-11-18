import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import CiJobLogsDialog from '../components/CiJobLogsDialog.vue'
import en from '../i18n/en'

const api = vi.hoisted(() => vi.fn())
vi.mock('src/utils/api', () => ({ apiFetch: api }))
const response = {
  status: 'in_progress',
  conclusion: null,
  steps: [],
  logs: '<script>unsafe</script>',
  available: true,
  truncated: false,
}
let wrapper: ReturnType<typeof mount> | undefined
beforeEach(() => {
  vi.useFakeTimers()
  api.mockReset().mockResolvedValue(response)
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.useRealTimers()
})
function render() {
  wrapper = mount(CiJobLogsDialog, {
    props: { workspaceId: 'a', jobName: 'Test', url: 'https://github.com/o/r/actions/runs/1/job/2' },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
      stubs: {
        ...Object.fromEntries(
          ['QDialog', 'QCard', 'QCardSection'].map((name) => [name, { template: '<div><slot /></div>' }]),
        ),
        // Renders every option and the selected one through the real slots.
        QSelect: {
          props: ['options', 'modelValue'],
          template:
            '<div><div v-for="o in options" :key="String(o.value)" class="opt"><slot name="option" :opt="o" :item-props="{}" /></div>' +
            '<div class="selected"><slot name="selected-item" :opt="options.find(o => o.value === modelValue)" /></div></div>',
        },
        QItem: { template: '<div><slot /></div>' },
        QItemSection: { template: '<div><slot /></div>' },
        QItemLabel: { template: '<div><slot /></div>' },
      },
    },
  })
  return wrapper
}
it('renders plain text and polls until the job completes', async () => {
  const view = render()
  await flushPromises()
  expect(view.find('pre').text()).toBe(response.logs)
  expect(view.find('script').exists()).toBe(false)
  api.mockResolvedValue({ ...response, status: 'completed' })
  await vi.advanceTimersByTimeAsync(10_000)
  await flushPromises()
  expect(api).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(20_000)
  expect(api).toHaveBeenCalledTimes(2)
})
it('stops polling after unmount and cancels the request', async () => {
  render()
  await flushPromises()
  const signal = api.mock.calls[0]?.[1].signal as AbortSignal
  wrapper?.unmount()
  wrapper = undefined
  await vi.advanceTimersByTimeAsync(20_000)
  expect(signal.aborted).toBe(true)
  expect(api).toHaveBeenCalledTimes(1)
})
it('retries temporary errors and then stops after a bounded number of failures', async () => {
  api.mockRejectedValue(new Error('secret'))
  const view = render()
  await flushPromises()
  expect(view.find('[role="alert"]').exists()).toBe(true)
  expect(view.text()).not.toContain('secret')
  expect(view.text()).not.toContain(en['git.ciLogs.unavailable'])
  await vi.advanceTimersByTimeAsync(180_000)
  expect(api).toHaveBeenCalledTimes(6)
  expect(view.text()).toContain(en['git.ciLogs.retryStopped'])
})
it('discards a late result from another workspace', async () => {
  let resolve!: (value: typeof response) => void
  api.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const view = render()
  await view.setProps({ workspaceId: 'b' })
  await flushPromises()
  resolve({ ...response, logs: 'old workspace' })
  await flushPromises()
  expect(view.find('pre').text()).toBe(response.logs)
})

it('recovers automatically after a temporary failure', async () => {
  api.mockRejectedValueOnce(new Error('temporary'))
  const view = render()
  await flushPromises()
  await vi.advanceTimersByTimeAsync(10_000)
  await flushPromises()
  expect(api).toHaveBeenCalledTimes(2)
  expect(view.find('[role="alert"]').exists()).toBe(false)
  expect(view.find('pre').text()).toBe(response.logs)
})
it('waits for completed job logs to be published', async () => {
  api
    .mockResolvedValueOnce({ ...response, status: 'completed', available: false, logs: '' })
    .mockResolvedValue({ ...response, status: 'completed' })
  const view = render()
  await flushPromises()
  await vi.advanceTimersByTimeAsync(10_000)
  await flushPromises()
  expect(api).toHaveBeenCalledTimes(2)
  expect(view.find('pre').text()).toBe(response.logs)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(api).toHaveBeenCalledTimes(2)
})
it('bounds retries for permanently unavailable completed logs', async () => {
  api.mockResolvedValue({ ...response, status: 'completed', available: false, logs: '' })
  render()
  await flushPromises()
  await vi.advanceTimersByTimeAsync(180_000)
  expect(api).toHaveBeenCalledTimes(6)
})
it('pauses polling while hidden and resumes on return', async () => {
  render()
  await flushPromises()
  Object.defineProperty(document, 'hidden', { configurable: true, value: true })
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(30_000)
  expect(api).toHaveBeenCalledTimes(1)
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  document.dispatchEvent(new Event('visibilitychange'))
  await flushPromises()
  expect(api).toHaveBeenCalledTimes(2)
})

it('renders colored log text safely', async () => {
  api.mockResolvedValue({ ...response, logs: '\u001b[31m<img src=x onerror=alert(1)>\u001b[0m' })
  const view = render()
  await flushPromises()
  expect(view.find('pre').text()).toBe('<img src=x onerror=alert(1)>')
  expect(view.find('pre span').attributes('style')).toContain('color:')
  expect(view.find('img').exists()).toBe(false)
})

const T0 = '2026-11-18T10:00:00Z'
const iso = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString()
const timed = {
  ...response,
  startedAt: T0,
  completedAt: null,
  steps: [
    { number: 1, name: 'Setup', status: 'completed', conclusion: 'success', startedAt: iso(0), completedAt: iso(45) },
    { number: 2, name: 'Tests', status: 'in_progress', conclusion: null, startedAt: iso(50), completedAt: null },
    { number: 3, name: 'Deploy', status: 'pending', conclusion: null, startedAt: null, completedAt: null },
  ],
}
const optionTexts = (view: ReturnType<typeof render>) => view.findAll('.opt').map((o) => o.text())

it('shows durations in the options and the selected item: fixed, ticking, none', async () => {
  vi.setSystemTime(new Date(iso(60)))
  api.mockResolvedValue(timed)
  const view = render()
  await flushPromises()
  let texts = optionTexts(view)
  expect(texts[1]).toBe('1. Setup · success · 45 s')
  expect(texts[2]).toBe('2. Tests · in_progress · 10 s')
  expect(texts[3]).toBe('3. Deploy · pending')
  await vi.advanceTimersByTimeAsync(3000)
  texts = optionTexts(view)
  expect(texts[2]).toBe('2. Tests · in_progress · 13 s')
  expect(texts[1]).toBe('1. Setup · success · 45 s')
  expect(view.text()).toContain(`Total: 1 min 03 s`)
})

it('shows the duration in the selected item', async () => {
  vi.setSystemTime(new Date(iso(60)))
  api.mockResolvedValue(timed)
  const view = render()
  await flushPromises()
  ;(view.vm as unknown as { step: number | null }).step = 1
  await flushPromises()
  expect(view.find('.selected').text()).toContain('1. Setup · success · 45 s')
})

it('has no clock when the job is completed, and none after unmount', async () => {
  vi.setSystemTime(new Date(iso(60)))
  api.mockResolvedValue({
    ...timed,
    status: 'completed',
    conclusion: 'success',
    completedAt: iso(55),
    steps: timed.steps.map((item) => ({ ...item, status: 'completed', completedAt: item.startedAt ? iso(55) : null })),
  })
  const view = render()
  await flushPromises()
  expect(view.text()).toContain('Total: 55 s')
  expect(vi.getTimerCount()).toBe(0)
  wrapper?.unmount()
  wrapper = undefined
  expect(vi.getTimerCount()).toBe(0)
})

it('stops its clock on unmount while the job runs', async () => {
  vi.setSystemTime(new Date(iso(60)))
  api.mockResolvedValue(timed)
  render()
  await flushPromises()
  expect(vi.getTimerCount()).toBeGreaterThan(0)
  wrapper?.unmount()
  wrapper = undefined
  expect(vi.getTimerCount()).toBe(0)
})

it('renders exactly as before when the server sends no dates', async () => {
  api.mockResolvedValue({
    ...response,
    status: 'completed',
    steps: [{ number: 1, name: 'Setup', status: 'completed', conclusion: 'success' }],
  })
  const view = render()
  await flushPromises()
  expect(optionTexts(view)[1]).toBe('1. Setup · success')
  expect(view.text()).not.toContain('Total')
  expect(vi.getTimerCount()).toBe(0)
})

it('a clock tick neither rebuilds the step options nor re-renders the dialog, only the running duration', async () => {
  vi.setSystemTime(new Date(iso(60)))
  api.mockResolvedValue(timed)
  const view = render()
  await flushPromises()
  const vm = view.vm as unknown as { stepOptions: unknown }
  const options = vm.stepOptions
  const instance = view.vm.$ as unknown as { render: (...args: unknown[]) => unknown }
  const original = instance.render
  let renders = 0
  instance.render = (...args: unknown[]) => {
    renders++
    return original(...args)
  }
  await vi.advanceTimersByTimeAsync(3000)
  expect(vm.stepOptions).toBe(options)
  expect(renders).toBe(0)
  expect(optionTexts(view)[2]).toBe('2. Tests · in_progress · 13 s')
})
