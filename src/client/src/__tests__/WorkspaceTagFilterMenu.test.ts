import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import WorkspaceTagFilterMenu from '../components/WorkspaceTagFilterMenu.vue'
import en from '../i18n/en'

const passthrough = (name: string) => ({
  name,
  props: ['modelValue', 'label', 'color'],
  template: '<div><slot /></div>',
})
function mountMenu(
  modelValue: string[],
  tags = [
    { tag: 'back', count: 2 },
    { tag: 'docs', count: 1 },
  ],
) {
  return mount(WorkspaceTagFilterMenu, {
    props: { modelValue, tags },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
      stubs: {
        ...Object.fromEntries(
          [
            'q-btn',
            'q-menu',
            'q-list',
            'q-item',
            'q-item-section',
            'q-item-label',
            'q-badge',
            'q-tooltip',
            'q-separator',
            'q-icon',
          ].map((tag) => [tag, passthrough(tag)]),
        ),
        // Like the real QCheckbox: it stops its own click and emits instead.
        'q-checkbox': {
          name: 'QCheckbox',
          props: ['modelValue'],
          emits: ['update:modelValue'],
          template: '<div data-checkbox @click.stop="$emit(\'update:modelValue\', !modelValue)"></div>',
        },
      },
    },
  })
}

it('toggles a tag in and out of the selection', async () => {
  const view = mountMenu(['back'])
  const items = view.findAll('[data-tag]')
  expect(items.map((i) => i.text())).toEqual(['back2', 'docs1'])
  await items[1]!.trigger('click')
  expect(view.emitted('update:modelValue')?.[0]).toEqual([['back', 'docs']])
  await items[0]!.trigger('click')
  expect(view.emitted('update:modelValue')?.[1]).toEqual([[]])
})

it('shows the selected count and clears everything', async () => {
  const view = mountMenu(['back', 'docs'])
  expect(view.find('[data-tag-filter-count]').text()).toBe('2')
  await view.find('[data-tag-filter-clear]').trigger('click')
  expect(view.emitted('update:modelValue')?.[0]).toEqual([[]])
})

it('shows an empty state without tags and no count when nothing is selected', () => {
  const view = mountMenu([], [])
  expect(view.text()).toContain(en['workspace.tagFilterEmpty'])
  expect(view.find('[data-tag-filter-count]').exists()).toBe(false)
})

it('toggles a tag when its checkbox itself is clicked', async () => {
  const view = mountMenu([])
  await view.findAll('[data-checkbox]')[1]!.trigger('click')
  expect(view.emitted('update:modelValue')).toEqual([[['docs']]])
})
