import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import WorktreeKeptAiNotice from '../components/WorktreeKeptAiNotice.vue'
import en from '../i18n/en'

const copyToClipboard = vi.fn()
vi.mock('src/utils/clipboard', () => ({ copyToClipboard: (...args: unknown[]) => copyToClipboard(...args) }))

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
const PATH = '/w/.kobo-kept/ws1'

async function mountNotice(workspaceId: string, restoreData: string | null | undefined) {
  const { Quasar, QBtn, QTooltip, QIcon } =
    await vi.importActual<typeof import('quasar')>('quasar/dist/quasar.client.js')
  return mount(WorktreeKeptAiNotice, {
    props: { workspaceId, restoreData },
    global: { plugins: [i18n, Quasar], components: { QBtn, QTooltip, QIcon } },
  })
}

describe('WorktreeKeptAiNotice', () => {
  beforeEach(() => copyToClipboard.mockReset())

  it('renders the kept path', async () => {
    const wrapper = await mountNotice('ws1', JSON.stringify({ keptAiPath: PATH }))
    expect(wrapper.text()).toContain(`.ai folder kept: ${PATH}`)
    expect(wrapper.get('[data-test="kept-ai-path"]').text()).toBe(PATH)
  })

  it.each([
    ['another workspace id', 'ws2', JSON.stringify({ keptAiPath: PATH })],
    ['restore data without the key', 'ws1', JSON.stringify({ prNumber: 1 })],
    ['null', 'ws1', null],
    ['undefined', 'ws1', undefined],
    ['invalid JSON', 'ws1', '{not json'],
  ])('renders nothing for %s', async (_label, id, data) => {
    const wrapper = await mountNotice(id, data)
    expect(wrapper.html()).toBe('<!--v-if-->')
  })

  it('has a labelled copy button that copies the path', async () => {
    const wrapper = await mountNotice('ws1', JSON.stringify({ keptAiPath: PATH }))
    const button = wrapper.get('[data-test="kept-ai-copy"]')
    expect(button.attributes('aria-label')).toBe('Copy the path')
    await button.trigger('click')
    expect(copyToClipboard).toHaveBeenCalledTimes(1)
    expect(copyToClipboard.mock.calls[0]![2]).toBe(PATH)
  })

  it('lets a very long path wrap and be selected, without a fixed width', async () => {
    const longPath = `/${'very-long-folder-name/'.repeat(12)}.kobo-kept/ws1`
    const wrapper = await mountNotice('ws1', JSON.stringify({ keptAiPath: longPath }))
    const path = wrapper.get('[data-test="kept-ai-path"]')
    expect(path.text()).toBe(longPath)
    expect(path.classes()).toContain('kept-ai-path')
    expect(path.classes()).not.toContain('ellipsis')
    expect(path.attributes('style') ?? '').not.toMatch(/width/)
  })
})
