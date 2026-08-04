import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { createI18n } from 'vue-i18n'
import WorkspaceWhipControl from '../components/WorkspaceWhipControl.vue'
import en from '../i18n/en'
import { useSettingsStore } from '../stores/settings'
import { useWebSocketStore } from '../stores/websocket'
import { useWorkspaceStore } from '../stores/workspace'
import { createWhipCrackCoordinator } from '../utils/whip-crack'

const doubles = vi.hoisted(() => ({
  enqueue: vi.fn(async () => undefined),
  dispose: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('../utils/whip-crack', () => ({
  createWhipCrackCoordinator: vi.fn(() => ({
    enqueue: doubles.enqueue,
    dispose: doubles.dispose,
  })),
}))

vi.mock('quasar', async (importOriginal) => {
  const original = await importOriginal<typeof import('quasar')>()
  return { ...original, Notify: { create: doubles.notify } }
})

const QBtnStub = defineComponent({
  name: 'QBtn',
  props: { label: String },
  emits: ['click'],
  template: '<button class="whip-button" @click="$emit(\'click\')">{{ label }}<slot /></button>',
})

const WhipOverlayStub = defineComponent({
  name: 'WhipOverlay',
  props: { soundEnabled: Boolean, soundVolume: Number },
  emits: ['crack', 'closed'],
  template: '<div class="whip-overlay-stub" />',
})

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })

function mountControl(props: { workspaceId: string; sessionId: string | null; running: boolean }) {
  return mount(WorkspaceWhipControl, {
    props,
    global: {
      plugins: [i18n],
      stubs: {
        'q-btn': QBtnStub,
        'q-tooltip': { template: '<span><slot /></span>' },
        WhipOverlay: WhipOverlayStub,
      },
    },
  })
}

describe('WorkspaceWhipControl', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  afterEach(() => vi.restoreAllMocks())

  it('only exposes the control for a running workspace with a selected session', async () => {
    const stopped = mountControl({ workspaceId: 'ws-1', sessionId: 'session-1', running: false })
    expect(stopped.find('button').exists()).toBe(false)

    await stopped.setProps({ running: true, sessionId: null })
    expect(stopped.find('button').exists()).toBe(false)

    await stopped.setProps({ sessionId: 'session-1' })
    expect(stopped.get('button').text()).toContain('Whip')
  })

  it('captures the target and dispatches every overlay crack', async () => {
    const wrapper = mountControl({ workspaceId: 'ws-1', sessionId: 'session-1', running: true })
    await wrapper.get('button').trigger('click')

    expect(createWhipCrackCoordinator).toHaveBeenCalledWith(
      { workspaceId: 'ws-1', sessionId: 'session-1' },
      expect.arrayContaining(['Move faster, tocard!', 'Less thinking, more doing, tocard!']),
      expect.any(Object),
    )
    const overlay = wrapper.getComponent(WhipOverlayStub)
    overlay.vm.$emit('crack')
    overlay.vm.$emit('crack')
    expect(doubles.enqueue).toHaveBeenCalledTimes(2)
  })

  it('closes and disposes when the target workspace changes or the overlay closes', async () => {
    const wrapper = mountControl({ workspaceId: 'ws-1', sessionId: 'session-1', running: true })
    await wrapper.get('button').trigger('click')
    expect(wrapper.findComponent(WhipOverlayStub).exists()).toBe(true)

    await wrapper.setProps({ workspaceId: 'ws-2' })
    expect(doubles.dispose).toHaveBeenCalledOnce()
    expect(wrapper.findComponent(WhipOverlayStub).exists()).toBe(false)

    await wrapper.get('button').trigger('click')
    wrapper.getComponent(WhipOverlayStub).vm.$emit('closed')
    await wrapper.vm.$nextTick()
    expect(doubles.dispose).toHaveBeenCalledTimes(2)
    expect(wrapper.findComponent(WhipOverlayStub).exists()).toBe(false)
  })

  it('wires stores, sound preferences, and translated errors into the coordinator', async () => {
    const workspaceStore = useWorkspaceStore()
    const websocketStore = useWebSocketStore()
    const settingsStore = useSettingsStore()
    settingsStore.global.audioNotifications = true
    settingsStore.global.audioNotificationVolume = 0.4
    const interrupt = vi.spyOn(workspaceStore, 'interruptAgent').mockResolvedValue()
    const send = vi.spyOn(websocketStore, 'sendChatMessage').mockReturnValue(true)
    const wrapper = mountControl({ workspaceId: 'ws-1', sessionId: 'session-1', running: true })

    await wrapper.get('button').trigger('click')
    const dependencies = vi.mocked(createWhipCrackCoordinator).mock.calls[0]![2]
    await dependencies.interruptAgent('ws-1')
    dependencies.sendMessage('ws-1', 'Move faster, tocard!', 'session-1')
    dependencies.onError()

    expect(interrupt).toHaveBeenCalledWith('ws-1')
    expect(send).toHaveBeenCalledWith('ws-1', 'Move faster, tocard!', 'session-1')
    expect(doubles.notify).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Unable to send the whip message', position: 'top' }),
    )
    expect(wrapper.getComponent(WhipOverlayStub).props()).toMatchObject({
      soundEnabled: true,
      soundVolume: 0.4,
    })
  })
})
