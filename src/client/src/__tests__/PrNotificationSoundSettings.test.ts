import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createI18n } from 'vue-i18n'
import PrNotificationSoundSettings from '../components/PrNotificationSoundSettings.vue'
import en from '../i18n/en'
import { playNotificationSound } from '../utils/notifications'

vi.mock('../utils/notifications', () => ({ playNotificationSound: vi.fn() }))

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })

function controlStub(name: string) {
  return defineComponent({
    name,
    inheritAttrs: false,
    props: {
      modelValue: { default: undefined },
      options: { type: Array, default: () => [] },
      label: { type: String, default: '' },
      disable: Boolean,
    },
    emits: ['update:modelValue', 'click'],
    setup(props, { slots }) {
      return () => h('div', { class: `${name}-stub` }, [props.label, slots.default?.()])
    },
  })
}

const stubs = {
  QToggle: controlStub('QToggle'),
  QSelect: controlStub('QSelect'),
  QBtn: controlStub('QBtn'),
  QSlider: controlStub('QSlider'),
}

const modelValue = {
  audioPrCiFailedSound: 'faaah.mp3',
  audioPrCiFailedEnabled: true,
  audioPrCiFailedVolume: 0.35,
  audioPrCiRecoveredSound: 'inherit',
  audioPrCiRecoveredEnabled: true,
  audioPrCiRecoveredVolume: 1,
  audioPrChangesRequestedSound: 'inherit',
  audioPrChangesRequestedEnabled: true,
  audioPrChangesRequestedVolume: 1,
  audioPrApprovedSound: 'inherit',
  audioPrApprovedEnabled: true,
  audioPrApprovedVolume: 1,
  audioPrMergeConflictSound: 'inherit',
  audioPrMergeConflictEnabled: true,
  audioPrMergeConflictVolume: 1,
  audioPrReadyToMergeSound: 'inherit',
  audioPrReadyToMergeEnabled: true,
  audioPrReadyToMergeVolume: 1,
  audioPrMergedSound: 'inherit',
  audioPrMergedEnabled: true,
  audioPrMergedVolume: 1,
}

function mountSettings() {
  return mount(PrNotificationSoundSettings, {
    props: {
      modelValue,
      generalSound: 'hey.mp3',
    },
    global: { plugins: [i18n], stubs },
  })
}

describe('PrNotificationSoundSettings', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders every PR event as a complete notification card', () => {
    const wrapper = mountSettings()

    expect(wrapper.findAll('.notification-sound-card')).toHaveLength(7)
    expect(wrapper.findAllComponents({ name: 'QToggle' })).toHaveLength(7)
    expect(wrapper.findAllComponents({ name: 'QSelect' })).toHaveLength(7)
    expect(wrapper.findAllComponents({ name: 'QBtn' })).toHaveLength(7)
    expect(wrapper.findAllComponents({ name: 'QSlider' })).toHaveLength(7)
    const optionLabels = wrapper
      .findAllComponents({ name: 'QSelect' })
      .flatMap((select) => (select.props('options') as Array<{ label: string }>).map((option) => option.label))
    expect(optionLabels).not.toContain('No sound')
  })

  it('updates only the first event toggle and volume', async () => {
    const wrapper = mountSettings()

    wrapper.findAllComponents({ name: 'QToggle' })[0]!.vm.$emit('update:modelValue', false)
    wrapper.findAllComponents({ name: 'QSlider' })[0]!.vm.$emit('update:modelValue', 0.6)
    await wrapper.vm.$nextTick()

    const updates = wrapper.emitted('update:modelValue') as Array<[typeof modelValue]>
    expect(updates[0]![0]).toMatchObject({
      ...modelValue,
      audioPrCiFailedEnabled: false,
    })
    expect(updates[1]![0]).toMatchObject({
      ...modelValue,
      audioPrCiFailedVolume: 0.6,
    })
  })

  it('previews with the event-specific volume', () => {
    const wrapper = mountSettings()

    wrapper.findAllComponents({ name: 'QBtn' })[0]!.vm.$emit('click')

    expect(playNotificationSound).toHaveBeenCalledWith('faaah.mp3', 0.35)
  })
})
