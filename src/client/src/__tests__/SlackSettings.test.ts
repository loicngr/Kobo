import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import SlackSettings from '../components/SlackSettings.vue'
import en from '../i18n/en'
import { useSettingsStore } from '../stores/settings'
import { type SlackStatus, useSlackStore } from '../stores/slack'

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })

async function mountWith(configured: boolean, extra: Partial<SlackStatus> = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const slack = useSlackStore()
  const status: SlackStatus = { configured, enabled: true, connected: false, allowListEmpty: false, ...extra }
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

  it.each([
    ['slack-notify-compaction', 'slackNotifyCompaction'],
    ['slack-notify-errors', 'slackNotifyErrors'],
  ])('saves %s from the Slack integration tab', async (id, key) => {
    const wrapper = await mountWith(true)
    const settings = useSettingsStore()
    const update = vi.spyOn(settings, 'updateGlobal').mockResolvedValue()
    settings.global.slackEnabled = true
    await wrapper.vm.$nextTick()
    await wrapper.get(`[data-test="${id}"]`).trigger('click')
    expect(update).toHaveBeenCalledWith({ [key]: true })
  })

  it('submits both token inputs through their shared form', async () => {
    const wrapper = await mountWith(true)
    const form = wrapper.get('form')
    expect(form.get('input[name="username"][autocomplete="username"]').element.hasAttribute('hidden')).toBe(true)
    const save = vi.spyOn(useSlackStore(), 'saveCredentials').mockResolvedValue()
    expect(wrapper.get('[data-test="slack-save-credentials"]').attributes('type')).toBe('submit')
    expect(wrapper.get('[data-test="slack-remove-credentials"]').attributes('type')).toBe('button')
    await form.trigger('submit')
    expect(save).not.toHaveBeenCalled()
    for (const id of ['slack-bot-token', 'slack-app-token']) {
      const input = wrapper.find(`[data-test="${id}"] input, input[data-test="${id}"]`)
      expect(input.attributes('autocomplete')).toBe('new-password')
      expect(input.attributes('type')).toBe('password')
      expect(input.element.closest('form')).toBe(form.element)
      await input.setValue(id)
    }
    await form.trigger('submit')
    expect(save).toHaveBeenCalledExactlyOnceWith({ botToken: 'slack-bot-token', appToken: 'slack-app-token' })
  })

  it('shows member names and saves selected IDs alongside existing unlisted IDs', async () => {
    const wrapper = await mountWith(true)
    const slack = useSlackStore()
    vi.spyOn(slack, 'fetchMembers').mockResolvedValue([{ id: 'UALICE', name: 'Alice' }])
    const settings = useSettingsStore()
    settings.global.slackAllowedUserIds = ['UOTHER']
    const update = vi.spyOn(settings, 'updateGlobal').mockResolvedValue()
    slack.status = { enabled: true, configured: true, allowListEmpty: false, connected: true }
    await new Promise((r) => setTimeout(r))
    const select = wrapper.getComponent({ name: 'QSelect' })
    expect(select.props('options')).toEqual(['UALICE'])
    expect(select.props('optionLabel')('UALICE')).toBe('Alice (UALICE)')
    expect(select.props('modelValue')).toEqual(['UOTHER'])
    select.vm.$emit('update:modelValue', ['UOTHER', 'UALICE'])
    await wrapper.get('[data-test="slack-save-allowed"]').trigger('click')
    expect(update).toHaveBeenCalledExactlyOnceWith({ slackAllowedUserIds: ['UOTHER', 'UALICE'] })
  })

  it('warns when the allow-list is empty', async () => {
    expect((await mountWith(true)).find('[data-test="slack-allow-list-empty"]').exists()).toBe(false)
    const wrapper = await mountWith(true, { allowListEmpty: true })
    expect(wrapper.find('[data-test="slack-allow-list-empty"]').text()).toBe(en['slack.allowListEmpty'])
  })

  it('describes the last inbound message', async () => {
    const at = new Date().toISOString()
    const ignored = await mountWith(true, { lastInbound: { at, outcome: 'ignored', reason: 'not-allowed' } })
    expect(ignored.find('[data-test="slack-last-inbound"]').text()).toBe(
      en['slack.lastInbound.line']
        .replace('{time}', en['common.justNow'])
        .replace('{outcome}', en['slack.lastInbound.ignoredNotAllowed']),
    )
    const uncertain = await mountWith(true, { lastInbound: { at, outcome: 'uncertain' } })
    expect(uncertain.find('[data-test="slack-last-inbound"]').text()).toContain(en['slack.lastInbound.uncertain'])
    const none = await mountWith(true)
    expect(none.find('[data-test="slack-last-inbound"]').text()).toBe(en['slack.lastInbound.none'])
  })
})
