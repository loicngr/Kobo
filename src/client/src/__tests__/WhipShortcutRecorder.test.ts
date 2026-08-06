import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import WhipShortcutRecorder from '../components/WhipShortcutRecorder.vue'
import en from '../i18n/en'

const QBtnStub = defineComponent({
  name: 'QBtn',
  inheritAttrs: false,
  emits: ['click'],
  template: '<button v-bind="$attrs" @click="$emit(\'click\', $event)"><slot /></button>',
})

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })

function mountRecorder(modelValue = 'mod+shift+x') {
  return mount(WhipShortcutRecorder, {
    props: { modelValue },
    global: {
      plugins: [i18n],
      stubs: {
        'q-btn': QBtnStub,
        'q-tooltip': { template: '<span><slot /></span>' },
      },
    },
  })
}

describe('WhipShortcutRecorder', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('formats the current shortcut and captures a replacement', async () => {
    const wrapper = mountRecorder()
    expect(wrapper.get('[data-testid="whip-shortcut-value"]').text()).toBe('Ctrl+Shift+X')

    await wrapper.get('[data-testid="whip-shortcut-recorder"]').trigger('click')
    const event = new KeyboardEvent('keydown', { key: 'k', altKey: true, cancelable: true })
    window.dispatchEvent(event)
    await nextTick()

    expect(event.defaultPrevented).toBe(true)
    expect(wrapper.emitted('update:modelValue')).toEqual([['alt+k']])
  })

  it('exposes the current shortcut and recording state to assistive technology', async () => {
    const wrapper = mountRecorder()
    const button = wrapper.get('[data-testid="whip-shortcut-recorder"]')

    expect(button.attributes('aria-label')).toContain('Whip shortcut')
    expect(button.attributes('aria-label')).toContain('Ctrl+Shift+X')
    expect(button.attributes('aria-pressed')).toBe('false')

    await button.trigger('click')

    expect(button.attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[role="status"]').text()).toBe('Press a shortcut…')
  })

  it('cancels capture on Escape without changing the value', async () => {
    const wrapper = mountRecorder('alt+k')
    await wrapper.get('[data-testid="whip-shortcut-recorder"]').trigger('click')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    await nextTick()

    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(wrapper.get('[data-testid="whip-shortcut-value"]').text()).toBe('Alt+K')
  })

  it('keeps recording after a modifier-only key', async () => {
    const wrapper = mountRecorder()
    await wrapper.get('[data-testid="whip-shortcut-recorder"]').trigger('click')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true, cancelable: true }))
    await nextTick()

    expect(wrapper.get('[data-testid="whip-shortcut-value"]').text()).toBe('Press a shortcut…')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('rejects a browser-reserved shortcut and keeps capture active', async () => {
    const wrapper = mountRecorder()
    await wrapper.get('[data-testid="whip-shortcut-recorder"]').trigger('click')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, cancelable: true }))
    await nextTick()

    expect(wrapper.get('[role="alert"]').text()).toBe('This shortcut is reserved by the browser.')
    expect(wrapper.get('[data-testid="whip-shortcut-value"]').text()).toBe('Press a shortcut…')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('clears a reserved-shortcut error when capture is cancelled', async () => {
    const wrapper = mountRecorder()
    await wrapper.get('[data-testid="whip-shortcut-recorder"]').trigger('click')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, cancelable: true }))
    await nextTick()
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    await nextTick()

    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('resets to the portable default', async () => {
    const wrapper = mountRecorder('alt+k')

    await wrapper.get('[data-testid="whip-shortcut-reset"]').trigger('click')

    expect(wrapper.emitted('update:modelValue')).toEqual([['mod+shift+x']])
  })

  it('removes its capture listener when unmounted', async () => {
    const wrapper = mountRecorder()
    await wrapper.get('[data-testid="whip-shortcut-recorder"]').trigger('click')
    wrapper.unmount()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', altKey: true, cancelable: true }))

    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })
})
