import { mount, type VueWrapper } from '@vue/test-utils'
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

const WhipOverlayStub = defineComponent({
  name: 'WhipOverlay',
  props: { soundEnabled: Boolean, soundVolume: Number },
  emits: ['crack', 'closed'],
  template: '<div class="whip-overlay-stub" />',
})

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
const wrappers: VueWrapper[] = []

function mountControl(props: { workspaceId: string; sessionId: string | null; running: boolean }, whipEnabled = true) {
  const settings = useSettingsStore()
  settings.global.whipEnabled = whipEnabled
  settings.global.whipShortcut = 'mod+shift+x'
  const wrapper = mount(WorkspaceWhipControl, {
    props,
    global: {
      plugins: [i18n],
      stubs: { WhipOverlay: WhipOverlayStub },
    },
  })
  wrappers.push(wrapper)
  return wrapper
}

function dispatchShortcut(overrides: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'x',
    ctrlKey: true,
    shiftKey: true,
    cancelable: true,
    ...overrides,
  })
  window.dispatchEvent(event)
  return event
}

async function openWhip(wrapper: VueWrapper): Promise<KeyboardEvent> {
  const event = dispatchShortcut()
  await wrapper.vm.$nextTick()
  return event
}

describe('WorkspaceWhipControl', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    document.body.innerHTML = ''
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('removes the button and only consumes the shortcut for an eligible workspace', async () => {
    const wrapper = mountControl({ workspaceId: 'ws-1', sessionId: 'session-1', running: false })
    expect(wrapper.find('button').exists()).toBe(false)

    const stoppedEvent = dispatchShortcut()
    expect(stoppedEvent.defaultPrevented).toBe(false)

    await wrapper.setProps({ running: true, sessionId: null })
    const missingSessionEvent = dispatchShortcut()
    expect(missingSessionEvent.defaultPrevented).toBe(false)

    await wrapper.setProps({ sessionId: 'session-1' })
    const eligibleEvent = dispatchShortcut()
    await wrapper.vm.$nextTick()
    expect(eligibleEvent.defaultPrevented).toBe(true)
    expect(wrapper.findComponent(WhipOverlayStub).exists()).toBe(true)
  })

  it('does not consume the shortcut while the whip feature is disabled', () => {
    const wrapper = mountControl({ workspaceId: 'ws-1', sessionId: 'session-1', running: true }, false)

    const event = dispatchShortcut()

    expect(event.defaultPrevented).toBe(false)
    expect(wrapper.findComponent(WhipOverlayStub).exists()).toBe(false)
  })

  it('opens and closes the overlay with successive shortcut presses', async () => {
    const wrapper = mountControl({ workspaceId: 'ws-1', sessionId: 'session-1', running: true })

    expect((await openWhip(wrapper)).defaultPrevented).toBe(true)
    expect(wrapper.findComponent(WhipOverlayStub).exists()).toBe(true)

    const closeEvent = dispatchShortcut()
    await wrapper.vm.$nextTick()
    expect(closeEvent.defaultPrevented).toBe(true)
    expect(doubles.dispose).toHaveBeenCalledOnce()
    expect(wrapper.findComponent(WhipOverlayStub).exists()).toBe(false)
  })

  it('works while a text input owns focus', async () => {
    const wrapper = mountControl({ workspaceId: 'ws-1', sessionId: 'session-1', running: true })
    const input = document.createElement('input')
    input.addEventListener('keydown', (event) => event.stopPropagation())
    document.body.append(input)
    input.focus()

    const event = new KeyboardEvent('keydown', {
      key: 'x',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    input.dispatchEvent(event)
    await wrapper.vm.$nextTick()

    expect(document.activeElement).toBe(input)
    expect(event.defaultPrevented).toBe(true)
    expect(wrapper.findComponent(WhipOverlayStub).exists()).toBe(true)
  })

  it('ignores repeated and non-matching keydown events', () => {
    const wrapper = mountControl({ workspaceId: 'ws-1', sessionId: 'session-1', running: true })

    const repeated = dispatchShortcut({ repeat: true })
    const nonMatching = dispatchShortcut({ key: 'j' })

    expect(repeated.defaultPrevented).toBe(false)
    expect(nonMatching.defaultPrevented).toBe(false)
    expect(wrapper.findComponent(WhipOverlayStub).exists()).toBe(false)
  })

  it('supports a custom single-key shortcut', async () => {
    const wrapper = mountControl({ workspaceId: 'ws-1', sessionId: 'session-1', running: true })
    useSettingsStore().global.whipShortcut = 'k'

    const event = dispatchShortcut({ key: 'k', ctrlKey: false, shiftKey: false })
    await wrapper.vm.$nextTick()

    expect(event.defaultPrevented).toBe(true)
    expect(wrapper.findComponent(WhipOverlayStub).exists()).toBe(true)
  })

  it('removes its keyboard listener when unmounted', () => {
    const wrapper = mountControl({ workspaceId: 'ws-1', sessionId: 'session-1', running: true })
    wrapper.unmount()

    const event = dispatchShortcut()

    expect(event.defaultPrevented).toBe(false)
  })

  it('closes and disposes an active whip when the feature is disabled', async () => {
    const wrapper = mountControl({ workspaceId: 'ws-1', sessionId: 'session-1', running: true })
    await openWhip(wrapper)

    useSettingsStore().global.whipEnabled = false
    await wrapper.vm.$nextTick()

    expect(doubles.dispose).toHaveBeenCalledOnce()
    expect(wrapper.findComponent(WhipOverlayStub).exists()).toBe(false)
  })

  it('captures the target and dispatches every overlay crack', async () => {
    const wrapper = mountControl({ workspaceId: 'ws-1', sessionId: 'session-1', running: true })
    await openWhip(wrapper)

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
    await openWhip(wrapper)

    await wrapper.setProps({ workspaceId: 'ws-2' })
    expect(doubles.dispose).toHaveBeenCalledOnce()
    expect(wrapper.findComponent(WhipOverlayStub).exists()).toBe(false)

    await openWhip(wrapper)
    wrapper.getComponent(WhipOverlayStub).vm.$emit('closed')
    await wrapper.vm.$nextTick()
    expect(doubles.dispose).toHaveBeenCalledTimes(2)
    expect(wrapper.findComponent(WhipOverlayStub).exists()).toBe(false)
  })

  it('closes when the agent stops naturally', async () => {
    const wrapper = mountControl({ workspaceId: 'ws-1', sessionId: 'session-1', running: true })
    await openWhip(wrapper)

    await wrapper.setProps({ running: false })

    expect(doubles.dispose).toHaveBeenCalledOnce()
    expect(wrapper.findComponent(WhipOverlayStub).exists()).toBe(false)
  })

  it('allows the shortcut to close the overlay during a soft interrupt grace period', async () => {
    vi.useFakeTimers()
    const wrapper = mountControl({ workspaceId: 'ws-1', sessionId: 'session-1', running: true })
    await openWhip(wrapper)
    wrapper.getComponent(WhipOverlayStub).vm.$emit('crack')

    await wrapper.setProps({ running: false })
    expect(wrapper.findComponent(WhipOverlayStub).exists()).toBe(true)

    const event = dispatchShortcut()
    await wrapper.vm.$nextTick()
    expect(event.defaultPrevented).toBe(true)
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

    await openWhip(wrapper)
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
