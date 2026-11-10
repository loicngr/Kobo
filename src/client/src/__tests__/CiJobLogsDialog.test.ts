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
      stubs: Object.fromEntries(
        ['QDialog', 'QCard', 'QCardSection'].map((name) => [name, { template: '<div><slot /></div>' }]),
      ),
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
