import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import CreationAttachments from '../components/CreationAttachments.vue'
import en from '../i18n/en'

const wrappers: VueWrapper[] = []
const revoke = vi.fn()
const create = vi.fn()
beforeEach(() => {
  revoke.mockReset()
  create.mockReset().mockImplementation(() => `blob:preview-${create.mock.calls.length}`)
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = create
      static revokeObjectURL = revoke
    },
  )
})
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  vi.unstubAllGlobals()
})

function mountAttachments() {
  const wrapper = mount(CreationAttachments, {
    props: {
      modelValue: [] as File[],
      'onUpdate:modelValue': (files) => {
        void wrapper.setProps({ modelValue: files })
      },
    },
    slots: { default: '<textarea />' },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
      stubs: {
        QBtn: defineComponent({
          props: ['disable', 'label'],
          template: '<button :disabled="disable">{{ label }}<slot /></button>',
        }),
        QTooltip: true,
      },
    },
  })
  wrappers.push(wrapper)
  return wrapper
}

function paste(file: File, text = '') {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: {
      items: [{ kind: 'file', getAsFile: () => file }],
      getData: () => text,
    },
  })
  return event
}

describe('creation image attachments', () => {
  it('pastes an image, shows its preview and releases it when removed', async () => {
    const wrapper = mountAttachments()
    const file = new File(['png'], 'screen.png', { type: 'image/png' })
    const event = paste(file)
    wrapper.get('textarea').element.dispatchEvent(event)
    await nextTick()
    expect(event.defaultPrevented).toBe(true)
    expect(wrapper.props('modelValue')).toEqual([file])
    expect(wrapper.get('img').attributes('src')).toBe('blob:preview-1')
    await wrapper.get('button[aria-label="Remove attachment"]').trigger('click')
    expect(wrapper.props('modelValue')).toEqual([])
    expect(revoke).toHaveBeenCalledWith('blob:preview-1')
  })

  it('keeps accompanying clipboard text available to the textarea', async () => {
    const wrapper = mountAttachments()
    const event = paste(new File(['png'], 'screen.png', { type: 'image/png' }), 'Expected appearance')
    wrapper.get('textarea').element.dispatchEvent(event)
    await nextTick()
    expect(event.defaultPrevented).toBe(false)
    expect(wrapper.props('modelValue')).toHaveLength(1)
  })

  it('accepts multiple dropped files and rejects invalid additions without losing existing files', async () => {
    const wrapper = mountAttachments()
    const files = [
      new File(['png'], 'a.png', { type: 'image/png' }),
      new File(['jpg'], 'b.jpg', { type: 'image/jpeg' }),
    ]
    await wrapper.trigger('drop', { dataTransfer: { files } })
    expect(wrapper.props('modelValue')).toEqual(files)
    await wrapper.trigger('drop', {
      dataTransfer: { files: [new File(['svg'], 'bad.svg', { type: 'image/svg+xml' })] },
    })
    expect(wrapper.props('modelValue')).toEqual(files)
    expect(wrapper.get('[role="alert"]').text()).toContain('PNG, JPEG, GIF or WebP')
    wrapper.unmount()
    expect(revoke).toHaveBeenCalledTimes(2)
    wrappers.splice(wrappers.indexOf(wrapper), 1)
  })

  it('accepts documents alongside images and only creates image previews', async () => {
    const wrapper = mountAttachments()
    const files = [
      new File(['# Brief'], 'brief.md'),
      new File(['%PDF'], 'brief.pdf', { type: 'application/pdf' }),
      new File(['png'], 'screen.png', { type: 'image/png' }),
    ]
    await wrapper.trigger('drop', { dataTransfer: { files } })
    expect(wrapper.props('modelValue')).toEqual(files)
    expect(wrapper.findAll('li')).toHaveLength(3)
    expect(wrapper.findAll('img')).toHaveLength(1)
    expect(create).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('brief.md')
    expect(wrapper.text()).toContain('brief.pdf')
    await wrapper.get('li button').trigger('click')
    expect(wrapper.props('modelValue')).toEqual(files.slice(1))
    expect(revoke).not.toHaveBeenCalled()
  })

  it('selects files from the picker and freezes attachments while creation is in progress', async () => {
    const wrapper = mountAttachments()
    const file = new File(['png'], 'screen.png', { type: 'image/png' })
    Object.defineProperty(wrapper.get('input').element, 'files', { configurable: true, value: [file] })
    await wrapper.get('input').trigger('change')
    expect(wrapper.props('modelValue')).toEqual([file])
    await wrapper.setProps({ disabled: true })
    wrapper.get('textarea').element.dispatchEvent(paste(new File(['png'], 'second.png', { type: 'image/png' })))
    await wrapper.get('button[aria-label="Remove attachment"]').trigger('click')
    expect(wrapper.props('modelValue')).toEqual([file])
    expect(wrapper.get('input').attributes()).toHaveProperty('disabled')
  })
})
