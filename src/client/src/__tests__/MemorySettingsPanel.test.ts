import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import MemorySettingsPanel from '../components/MemorySettingsPanel.vue'
import de from '../i18n/de'
import en from '../i18n/en'
import es from '../i18n/es'
import fr from '../i18n/fr'
import itLocale from '../i18n/it'
import { type MemoryScopeRecord, useMemoryStore } from '../stores/memory'

const global = { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] }
const scopes: MemoryScopeRecord[] = [
  { id: 'global', level: 'global', generation: 0, revision: 3 },
  { id: 'project:/stored-only', level: 'project', projectPath: '/stored-only', generation: 1, revision: 4 },
  { id: 'workspace:archived', level: 'workspace', workspaceId: 'archived-purged', generation: 2, revision: 5 },
]
const locales: Record<string, Record<string, string>> = { en, fr, de, es, it: itLocale }

describe('MemorySettingsPanel', () => {
  let memory: ReturnType<typeof useMemoryStore>

  beforeEach(() => {
    setActivePinia(createPinia())
    memory = useMemoryStore()
    memory.scopesByKey.all = { items: scopes }
    vi.spyOn(memory, 'loadScopes').mockResolvedValue(undefined)
    vi.spyOn(memory, 'loadEntries').mockResolvedValue(undefined)
    vi.spyOn(memory, 'loadProposals').mockResolvedValue(undefined)
    vi.spyOn(memory, 'loadOperations').mockResolvedValue(undefined)
  })

  it('shows Hybrid as the current mode and keeps mode selection in the parent draft', async () => {
    const wrapper = mount(MemorySettingsPanel, { props: { memoryMode: 'hybrid' }, global })
    const radios = wrapper.findAll('input[name="memory-mode"]')
    expect(radios).toHaveLength(3)
    expect((radios[2].element as HTMLInputElement).checked).toBe(true)
    await radios[0].setValue()
    expect(wrapper.emitted('update:memoryMode')?.[0]).toEqual(['manual'])
  })

  it.each([false, true])(
    'discards a delayed clear preview after scope changes (return to original=%s)',
    async (returnToOriginal) => {
      let finish!: (value: { revision: number; entries: number; proposals: number }) => void
      vi.spyOn(memory, 'previewClear').mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      const wrapper = mount(MemorySettingsPanel, { props: { memoryMode: 'hybrid' }, global })
      await flushPromises()
      await wrapper.get('[data-testid="memory-clear-preview"]').trigger('click')
      await wrapper.get('select').setValue('workspace:archived')
      if (returnToOriginal) await wrapper.get('select').setValue('global')
      finish({ revision: 3, entries: 99, proposals: 0 })
      await flushPromises()
      expect(wrapper.find('[data-testid="memory-clear-confirm"]').exists()).toBe(false)
    },
  )

  it('translates the Settings navigation, memory controls and guided tour in every locale', () => {
    const keys = [
      'settings.nav.memory',
      'settings.help.memory',
      'memory.settings.title',
      'memory.settings.modeHint.hybrid',
      'memory.settings.clearConfirm',
      'memory.settings.clearWarning',
      'memory.settings.deleteConfirm',
      'memory.settings.loadMoreScopes',
      'tours.settings.memory.title',
      'tours.settings.memory.description',
    ]
    for (const [locale, messages] of Object.entries(locales)) {
      for (const key of keys) expect(messages[key], `${locale}: ${key}`).toBeTypeOf('string')
    }
  })

  it('offers stored project, archived workspace and global scopes without filtering', async () => {
    const wrapper = mount(MemorySettingsPanel, { props: { memoryMode: 'hybrid' }, global })
    await flushPromises()
    const options = wrapper.findAll('select option').map((option) => option.text())
    expect(options).toContain('Project · /stored-only')
    expect(options).toContain('Workspace · archived-purged')
    expect(options).toContain('Global')
  })

  it('previews exact clear counts, leaves cancel side-effect free, and confirms the selected revision', async () => {
    vi.spyOn(memory, 'previewClear').mockResolvedValue({ revision: 5, entries: 7, proposals: 2 })
    const clear = vi.spyOn(memory, 'clearScope').mockResolvedValue({ entries: 7, proposals: 2 })
    const wrapper = mount(MemorySettingsPanel, { props: { memoryMode: 'hybrid' }, global })
    await wrapper.get('select').setValue('workspace:archived')
    await wrapper.get('[data-testid="memory-clear-preview"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('7')
    expect(wrapper.text()).toContain('2')
    await wrapper.get('[data-testid="memory-clear-cancel"]').trigger('click')
    expect(clear).not.toHaveBeenCalled()
    await wrapper.get('[data-testid="memory-clear-preview"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="memory-clear-confirm"]').trigger('click')
    await flushPromises()
    expect(clear).toHaveBeenCalledWith('workspace:archived', 5)
  })

  it('performs memory CRUD immediately without saving the Settings mode', async () => {
    const create = vi.spyOn(memory, 'createEntry').mockResolvedValue({
      id: 'new',
      scopeId: 'global',
      key: 'preference',
      title: 'Preference',
      body: 'Keep it',
      revision: 1,
      actor: { kind: 'human' },
      createdAt: 'now',
      updatedAt: 'now',
    })
    const wrapper = mount(MemorySettingsPanel, { props: { memoryMode: 'hybrid' }, global })
    await wrapper.get('input[name="memory-mode"][value="manual"]').setValue()
    expect(wrapper.emitted('update:memoryMode')?.[0]).toEqual(['manual'])
    await wrapper.get('select').setValue('global')
    await wrapper.get('[data-testid="memory-add-entry"]').trigger('click')
    await wrapper.get('input[name="key"]').setValue('preference')
    await wrapper.get('input[name="title"]').setValue('Preference')
    await wrapper.get('textarea[name="body"]').setValue('Keep it')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ scopeId: 'global', key: 'preference', title: 'Preference', body: 'Keep it' }),
    )
    expect(wrapper.emitted('update:memoryMode')).toHaveLength(1)
  })

  it('refreshes the clear preview after a revision conflict without clearing stale counts', async () => {
    const preview = vi
      .spyOn(memory, 'previewClear')
      .mockResolvedValueOnce({ revision: 5, entries: 7, proposals: 2 })
      .mockResolvedValueOnce({ revision: 6, entries: 8, proposals: 1 })
    vi.spyOn(memory, 'clearScope').mockRejectedValueOnce(Object.assign(new Error('revision conflict'), { status: 409 }))
    const wrapper = mount(MemorySettingsPanel, { props: { memoryMode: 'hybrid' }, global })
    await wrapper.get('select').setValue('workspace:archived')
    await wrapper.get('[data-testid="memory-clear-preview"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Workspace scope')
    expect(wrapper.text()).toContain('7 memories')
    await wrapper.get('[data-testid="memory-clear-confirm"]').trigger('click')
    await flushPromises()
    expect(preview).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('8 memories')
    expect(wrapper.text()).toContain('changed after the preview')
  })

  it('requires explicit confirmation before deleting a memory', async () => {
    const remove = vi.spyOn(memory, 'deleteEntry').mockResolvedValue(undefined)
    memory.entriesByKey['global\u0000'] = {
      items: [
        {
          id: 'entry-1',
          scopeId: 'global',
          key: 'goal',
          title: 'Goal',
          body: 'Keep this',
          revision: 1,
          actor: { kind: 'human' },
          createdAt: 'now',
          updatedAt: 'now',
        },
      ],
    }
    const wrapper = mount(MemorySettingsPanel, { props: { memoryMode: 'hybrid' }, global })
    await wrapper.get('select').setValue('global')
    await wrapper.get('button[aria-label="Delete Goal"]').trigger('click')
    await flushPromises()
    expect(remove).not.toHaveBeenCalled()
    await wrapper.get('select').setValue('workspace:archived')
    expect(wrapper.text()).toContain('Delete “Goal” from Global?')
    await wrapper.get('[data-testid="memory-delete-cancel"]').trigger('click')
    expect(remove).not.toHaveBeenCalled()
    await wrapper.get('select').setValue('global')
    await wrapper.get('button[aria-label="Delete Goal"]').trigger('click')
    await wrapper.get('[data-testid="memory-delete-confirm"]').trigger('click')
    await flushPromises()
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'entry-1', scopeId: 'global' }))
  })

  it('loads the next page of stored scopes so records after the first 50 are selectable', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      id: `project:${index}`,
      level: 'project' as const,
      projectPath: `/project/${index}`,
      generation: 0,
      revision: 0,
    }))
    memory.scopesByKey.all = { items: firstPage, nextCursor: '50' }
    const loadMore = vi.spyOn(memory, 'loadMoreScopes').mockImplementation(async () => {
      memory.scopesByKey.all = { items: [...firstPage, scopes[2]!], nextCursor: undefined }
    })
    const wrapper = mount(MemorySettingsPanel, { props: { memoryMode: 'hybrid' }, global })
    await flushPromises()
    expect(wrapper.findAll('select option')).toHaveLength(51)
    await wrapper.get('[data-testid="memory-load-more-scopes"]').trigger('click')
    await flushPromises()
    expect(loadMore).toHaveBeenCalledOnce()
    expect(wrapper.findAll('select option')).toHaveLength(52)
    expect(wrapper.text()).toContain('archived-purged')
  })

  it('promotes an entry to the explicitly selected stored scope', async () => {
    memory.entriesByKey['global\u0000'] = {
      items: [
        {
          id: 'entry-1',
          scopeId: 'global',
          key: 'goal',
          title: 'Goal',
          body: 'Keep',
          revision: 1,
          actor: { kind: 'human' },
          createdAt: 'now',
          updatedAt: 'now',
        },
      ],
    }
    const promote = vi.spyOn(memory, 'promoteEntry').mockResolvedValue({
      id: 'copy',
      scopeId: 'project:/stored-only',
      key: 'goal',
      title: 'Goal',
      body: 'Keep',
      revision: 1,
      actor: { kind: 'human' },
      createdAt: 'now',
      updatedAt: 'now',
    })
    const wrapper = mount(MemorySettingsPanel, { props: { memoryMode: 'hybrid' }, global })
    await flushPromises()
    await wrapper.get('button[aria-label="Promote Goal"]').trigger('click')
    const selects = wrapper.findAll('select')
    expect(selects).toHaveLength(2)
    await selects.at(-1)!.setValue('project:/stored-only')
    await wrapper.get('[data-testid="memory-promote-confirm"]').trigger('click')
    await flushPromises()
    expect(promote).toHaveBeenCalledWith(expect.objectContaining({ id: 'entry-1' }), 'project:/stored-only')
  })

  it('reloads the latest revision after 409 and rebases the preserved draft', async () => {
    const original = {
      id: 'entry-1',
      scopeId: 'global',
      key: 'goal',
      title: 'Goal',
      body: 'Old',
      revision: 1,
      actor: { kind: 'human' as const },
      createdAt: 'now',
      updatedAt: 'now',
    }
    memory.entriesByKey['global\u0000'] = { items: [original] }
    const update = vi
      .spyOn(memory, 'updateEntry')
      .mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409 }))
      .mockResolvedValue({ ...original, revision: 2, body: 'Draft' })
    vi.spyOn(memory, 'loadEntries').mockImplementation(async () => {
      memory.entriesByKey['global\u0000'] = { items: [{ ...original, revision: 2, body: 'Latest' }] }
    })
    const wrapper = mount(MemorySettingsPanel, { props: { memoryMode: 'hybrid' }, global })
    await flushPromises()
    await wrapper.get('button[aria-label="Edit Goal"]').trigger('click')
    await wrapper.get('textarea[name="body"]').setValue('Draft')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('changed elsewhere')
    expect((wrapper.get('textarea[name="body"]').element as HTMLTextAreaElement).value).toBe('Draft')
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Keep draft and rebase'))!
      .trigger('click')
    await flushPromises()
    expect((wrapper.get('textarea[name="body"]').element as HTMLTextAreaElement).value).toBe('Draft')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ revision: 2 }),
      expect.objectContaining({ body: 'Draft' }),
    )
  })
})
