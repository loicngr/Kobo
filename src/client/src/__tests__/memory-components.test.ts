import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import MemoryEntryEditor from '../components/memory/MemoryEntryEditor.vue'
import MemoryEntryList from '../components/memory/MemoryEntryList.vue'
import MemoryOperationsList from '../components/memory/MemoryOperationsList.vue'
import MemoryProposalList from '../components/memory/MemoryProposalList.vue'
import MemoryScopeSelect from '../components/memory/MemoryScopeSelect.vue'
import en from '../i18n/en'

const global = { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] }
const entry = {
  id: 'entry-1',
  scopeId: 'scope-1',
  key: 'workspace.goal',
  title: 'Goal',
  body: 'Keep the editor draft.',
  revision: 1,
  actor: { kind: 'human' as const },
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
}

describe('reusable memory components', () => {
  it('resets a dirty draft when switching to a different entry identity', async () => {
    const wrapper = mount(MemoryEntryEditor, { props: { scopeId: 'scope-1', entry }, global })
    await wrapper.get('input[name="title"]').setValue('Unsaved A')
    await wrapper.setProps({ entry: { ...entry, id: 'entry-2', title: 'Note B', revision: 3 } })
    expect((wrapper.get('input[name="title"]').element as HTMLInputElement).value).toBe('Note B')
    await wrapper.get('input[name="title"]').setValue('Edited B')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('save')?.[0]?.[0]).toMatchObject({ title: 'Edited B', expectedRevision: 3 })
  })

  it('resets an unsaved new memory when its destination scope changes', async () => {
    const wrapper = mount(MemoryEntryEditor, { props: { scopeId: 'scope-1' }, global })
    await wrapper.get('input[name="title"]').setValue('Draft in scope 1')
    await wrapper.setProps({ scopeId: 'scope-2' })
    expect((wrapper.get('input[name="title"]').element as HTMLInputElement).value).toBe('')
  })

  it('lets the user select an exact scope', async () => {
    const wrapper = mount(MemoryScopeSelect, {
      props: {
        scopes: [{ id: 'scope-1', level: 'workspace', workspaceId: 'ws-1', generation: 0, revision: 0 }],
        modelValue: '',
      },
      global,
    })
    await wrapper.find('select').setValue('scope-1')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['scope-1'])
  })

  it('emits an edit action for the selected entry', async () => {
    const wrapper = mount(MemoryEntryList, { props: { entries: [entry] }, global })
    await wrapper.get('button[aria-label="Edit Goal"]').trigger('click')
    expect(wrapper.emitted('edit')?.[0]).toEqual([entry])
  })

  it('preserves a dirty draft during background refresh', async () => {
    const wrapper = mount(MemoryEntryEditor, { props: { scopeId: 'scope-1', entry }, global })
    await wrapper.get('input[name="title"]').setValue('My unsaved title')
    await wrapper.setProps({ entry: { ...entry, title: 'Remote title', revision: 2 } })
    expect((wrapper.get('input[name="title"]').element as HTMLInputElement).value).toBe('My unsaved title')
  })

  it('requires an explicit rebase before saving a dirty draft against a newer revision', async () => {
    const wrapper = mount(MemoryEntryEditor, { props: { scopeId: 'scope-1', entry, conflict: true }, global })
    await wrapper.get('input[name="title"]').setValue('My draft')
    await wrapper.setProps({ entry: { ...entry, title: 'Remote', revision: 2 }, conflict: true })
    await wrapper.get('.memory-editor-conflict button:nth-of-type(2)').trigger('click')
    expect(wrapper.emitted('rebase')?.[0]).toEqual([2])
    expect((wrapper.get('input[name="title"]').element as HTMLInputElement).value).toBe('My draft')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('save')?.[0]?.[0]).toMatchObject({ title: 'My draft', expectedRevision: 2 })
  })

  it('emits explicit proposal decisions', async () => {
    const proposal = { ...entry, id: 'proposal-1' }
    const wrapper = mount(MemoryProposalList, { props: { proposals: [proposal] }, global })
    await wrapper.get('button[aria-label="Approve Goal"]').trigger('click')
    expect(wrapper.emitted('decision')?.[0]).toEqual(['proposal-1', 'approve'])
  })

  it('requests the next journal page only when a cursor exists', async () => {
    const wrapper = mount(MemoryOperationsList, {
      props: {
        operations: [{ id: 1, scopeId: 'scope-1', kind: 'created', actor: { kind: 'human' }, createdAt: 'now' }],
        hasMore: true,
      },
      global,
    })
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('loadMore')).toHaveLength(1)
  })
})
