import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import WorkspaceSlackChannel from '../components/WorkspaceSlackChannel.vue'
import en from '../i18n/en'
import { useSettingsStore } from '../stores/settings'
import { useSlackStore } from '../stores/slack'
import { useWorkspaceStore } from '../stores/workspace'

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })

async function mountWith(slackChannelId: string | null) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const settings = useSettingsStore()
  settings.global = { ...settings.global, slackEnabled: true }
  const slack = useSlackStore()
  vi.spyOn(slack, 'fetchChannels').mockResolvedValue([])
  const setMirror = vi.spyOn(slack, 'setQuestionMirror').mockResolvedValue('always')
  const update = vi.spyOn(useWorkspaceStore(), 'updateWorkspaceFromEvent').mockImplementation(() => undefined)
  const { Quasar, QSelect, QItem, QItemSection, QItemLabel, QSeparator } =
    await vi.importActual<typeof import('quasar')>('quasar/dist/quasar.client.js')
  const wrapper = mount(WorkspaceSlackChannel, {
    props: { workspaceId: 'w1', slackChannelId, slackQuestionMirror: 'never', open: false },
    global: { plugins: [pinia, i18n, Quasar], components: { QSelect, QItem, QItemSection, QItemLabel, QSeparator } },
  })
  await new Promise((r) => setTimeout(r))
  return { wrapper, setMirror, update }
}

describe('WorkspaceSlackChannel question mirror', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('hides the mirror select while no channel is linked', async () => {
    const { wrapper } = await mountWith(null)
    expect(wrapper.find('[data-test="workspace-slack-question-mirror"]').exists()).toBe(false)
  })

  it('shows the mirror select for a linked channel and saves a new mode', async () => {
    const { wrapper, setMirror, update } = await mountWith('C1')
    expect(wrapper.find('[data-test="workspace-slack-question-mirror"]').exists()).toBe(true)
    const mirror = wrapper.findAllComponents({ name: 'QSelect' }).at(-1)!
    mirror.vm.$emit('update:model-value', 'always')
    await new Promise((r) => setTimeout(r))
    expect(setMirror).toHaveBeenCalledWith('w1', 'always')
    expect(update).toHaveBeenCalledWith('w1', { slackQuestionMirror: 'always' })
  })
})
