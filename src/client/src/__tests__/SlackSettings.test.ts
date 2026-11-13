import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import SlackSettings from '../components/SlackSettings.vue'
import en from '../i18n/en'
import { useSlackStore } from '../stores/slack'

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })

async function mountWith(configured: boolean) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const slack = useSlackStore()
  const status = { configured, enabled: true, connected: false }
  vi.spyOn(slack, 'fetchStatus').mockImplementation(async () => {
    slack.status = status
  })
  const { Quasar, QInput, QBtn, QToggle, QSelect, QExpansionItem } =
    await vi.importActual<typeof import('quasar')>('quasar/dist/quasar.client.js')
  const wrapper = mount(SlackSettings, {
    global: { plugins: [pinia, i18n, Quasar], components: { QInput, QBtn, QToggle, QSelect, QExpansionItem } },
  })
  await new Promise((r) => setTimeout(r))
  return wrapper
}

describe('SlackSettings', () => {
  beforeEach(() => vi.restoreAllMocks())

  it.each([
    [false, false],
    [true, true],
  ])('remove button visibility when configured=%s', async (configured, visible) => {
    const wrapper = await mountWith(configured)
    expect(wrapper.find('[data-test="slack-remove-credentials"]').exists()).toBe(visible)
  })

  it('marks the native token inputs new-password', async () => {
    const wrapper = await mountWith(false)
    for (const id of ['slack-bot-token', 'slack-app-token']) {
      const input = wrapper.find(`[data-test="${id}"] input, input[data-test="${id}"]`)
      expect(input.attributes('autocomplete')).toBe('new-password')
      expect(input.attributes('type')).toBe('password')
    }
  })
})
