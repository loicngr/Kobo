import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { createI18n } from 'vue-i18n'
import DiffViewer from '../components/DiffViewer.vue'
import en from '../i18n/en'
import { useWorkspaceStore, type Workspace } from '../stores/workspace'
import { apiFetch } from '../utils/api'

vi.mock('monaco-editor/editor/editor.worker.js?worker', () => ({ default: class {} }))
const screen = reactive({ lt: { sm: false, md: false } })
const dialog = vi.fn(() => ({ onOk: () => ({ onCancel: (callback: () => void) => callback() }) }))
vi.mock('quasar', () => ({ useQuasar: () => ({ screen, notify: vi.fn(), dialog }) }))
const editorMock = vi.hoisted(() => ({
  create: vi.fn(),
  updateOptions: vi.fn(),
  dispose: vi.fn(),
  goToDiff: vi.fn(),
  layoutZone: vi.fn(),
  zones: [] as Array<{ heightInPx: number; showInHiddenAreas: boolean }>,
  models: [] as Array<{ value: string; change: () => void }>,
}))
vi.mock('monaco-editor/basic-languages/monaco.contribution.js', () => ({}))
vi.mock('src/monaco-contributions', () => ({}))
vi.mock('monaco-editor/editor/editor.api.js', () => ({
  KeyMod: { CtrlCmd: 1 },
  KeyCode: { KeyS: 1 },
  editor: {
    defineTheme: vi.fn(),
    createModel: (value: string) => {
      const model = {
        value,
        change: () => {},
        getValue: () => model.value,
        getLineCount: () => 10,
        onDidChangeContent: (callback: () => void) => {
          model.change = callback
          return { dispose: vi.fn() }
        },
        dispose: vi.fn(),
      }
      editorMock.models.push(model)
      return model
    },
    createDiffEditor: (...args: unknown[]) => {
      editorMock.create(...args)
      let model: unknown
      const pane = {
        getModel: () => ({ getLineCount: () => 10 }),
        getLayoutInfo: () => ({ contentLeft: 40, verticalScrollbarWidth: 10 }),
        revealLineInCenter: vi.fn(),
        onDidChangeCursorSelection: () => ({ dispose: vi.fn() }),
        getDomNode: () => document.createElement('div'),
        onMouseDown: () => ({ dispose: vi.fn() }),
        onDidScrollChange: () => ({ dispose: vi.fn() }),
        onDidLayoutChange: () => ({ dispose: vi.fn() }),
        changeViewZones: (callback: (accessor: object) => void) =>
          callback({
            removeZone: vi.fn(),
            layoutZone: editorMock.layoutZone,
            addZone: (zone: { heightInPx: number; showInHiddenAreas: boolean }) => {
              editorMock.zones.push(zone)
              return 'zone-1'
            },
          }),
      }
      return {
        setModel: (value: unknown) => {
          model = value
        },
        getModel: () => model,
        getModifiedEditor: () => pane,
        getOriginalEditor: () => pane,
        updateOptions: editorMock.updateOptions,
        dispose: editorMock.dispose,
        addCommand: vi.fn(),
        goToDiff: editorMock.goToDiff,
      }
    },
  },
}))
vi.mock('src/utils/api', async (original) => ({
  ...(await original<object>()),
  apiFetch: vi.fn(async () => ({ files: [], sourceBranch: 'main', workingBranch: 'feature/a' })),
}))

let wrapper: VueWrapper
let store: ReturnType<typeof useWorkspaceStore>

async function mountViewer(initialReviewMode = false) {
  wrapper = shallowMount(DiffViewer, {
    props: { workspaceId: 'ws-a', initialReviewMode },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
      directives: { 'close-popup': {} },
      stubs: {
        ...Object.fromEntries(
          [
            'QBadge',
            'QCheckbox',
            'QIcon',
            'QInput',
            'QSpinnerDots',
            'QItemSection',
            'QItem',
            'QList',
            'QMenu',
            'QSeparator',
            'QCardSection',
            'QCardActions',
            'QCard',
          ].map((name) => [name, true]),
        ),
        QBtn: {
          props: ['label', 'disable', 'icon'],
          template: '<button :disabled="disable"><slot />{{ label }}</button>',
        },
        QBtnDropdown: { template: '<div><slot /></div>' },
        QScrollArea: { template: '<div><slot /></div>' },
        QDialog: { name: 'QDialog', props: ['modelValue'], template: '<div v-if="modelValue"><slot /></div>' },
        QTree: { name: 'QTree', props: ['expanded', 'selected', 'nodes'], template: '<div />' },
        QBtnToggle: { name: 'QBtnToggle', props: ['modelValue', 'options'], template: '<div><slot /></div>' },
        QTooltip: { template: '<span><slot /></span>' },
      },
    },
  })
  await flushPromises()
}
function editToggle() {
  return wrapper
    .findAllComponents({ name: 'QBtnToggle' })
    .find((c) => c.props('options').some((o: { value: string }) => o.value === 'inspect'))!
}

beforeEach(() => {
  screen.lt.sm = false
  screen.lt.md = false
  editorMock.models.length = 0
  editorMock.zones.length = 0
  vi.clearAllMocks()
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    url.includes('/diff-file?')
      ? { original: 'before', modified: 'after', modifiedSha: 'sha' }
      : { files: [], sourceBranch: 'main', workingBranch: 'feature/a' },
  )
  setActivePinia(createPinia())
  store = useWorkspaceStore()
  store.workspaces = [{ id: 'ws-a', status: 'idle' } as Workspace]
})
afterEach(() => wrapper?.unmount())

describe('Diff viewer controls', () => {
  it('opens in inline view by default', async () => {
    await mountViewer()
    const layout = wrapper
      .findAllComponents({ name: 'QBtnToggle' })
      .find((c) => c.props('options').some((o: { value: string }) => o.value === 'inline'))!
    expect(layout.props('modelValue')).toBe('inline')
  })

  it.each(['executing', 'brainstorming', 'compacting', 'extracting'])(
    'disables edit and explains why while %s, then restores it',
    async (status) => {
      await mountViewer()
      expect(editToggle().props('options')[0].disable).toBe(false)
      store.workspaces[0]!.status = status
      await flushPromises()
      expect(editToggle().props('options')[0].disable).toBe(true)
      expect(editToggle().props('options')[1].disable).toBe(false)
      expect(wrapper.text()).toContain(en['diffViewer.agentRunning'])
      store.workspaces[0]!.status = 'idle'
      await flushPromises()
      expect(editToggle().props('options')[0].disable).toBe(false)
    },
  )

  it('also blocks editing when a live controller is present in an idle workspace', async () => {
    store.agentLiveness['ws-a'] = { status: 'running', agentSessionId: 'session-a', startedAt: '', lastEventAt: '' }
    await mountViewer()
    expect(editToggle().props('options')[0].disable).toBe(true)
    expect(wrapper.text()).toContain(en['diffViewer.agentRunning'])
  })
})

async function mountWithFiles(review = false) {
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    url.includes('/diff-file?')
      ? { original: 'before', modified: 'after', modifiedSha: 'sha' }
      : {
          files: [
            { path: 'src/a.ts', status: 'modified' },
            { path: 'src/b.ts', status: 'added' },
          ],
          sourceBranch: 'main',
          workingBranch: 'feature/a',
        },
  )
  await mountViewer(review)
}
async function selectFile(path = 'src/a.ts') {
  wrapper.findComponent({ name: 'QTree' }).vm.$emit('update:selected', `file:${path}`)
  await flushPromises()
}
async function clickButton(label: string) {
  const button = wrapper
    .findAll('button')
    .find((item) => item.text() === label || item.attributes('aria-label') === label)
  expect(button, label).toBeDefined()
  await button!.trigger('click')
  await flushPromises()
}

describe('Diff navigation and draft preservation', () => {
  it('toggles a folder from its header without selecting a file', async () => {
    await mountWithFiles()
    const tree = wrapper.findComponent({ name: 'QTree' })
    expect(tree.props('expanded')).toContain('dir:src')
    tree.vm.$emit('update:selected', 'dir:src')
    await flushPromises()
    expect(tree.props('expanded')).not.toContain('dir:src')
    expect(tree.props('selected')).toBe('')
    tree.vm.$emit('update:selected', 'dir:src')
    await flushPromises()
    expect(tree.props('expanded')).toContain('dir:src')
    expect(editorMock.create).not.toHaveBeenCalled()
  })

  it('keeps mobile panels exclusive and preserves desktop preferences', async () => {
    screen.lt.sm = screen.lt.md = true
    localStorage.setItem('kobo:diff:criteriaRail', '1')
    localStorage.setItem('kobo:diff:fileTree', '1')
    await mountWithFiles(true)
    expect(wrapper.find('.diff-file-list-wrapper').exists()).toBe(true)
    expect(wrapper.find('.diff-criteria-rail').exists()).toBe(false)
    await clickButton('Review · 0')
    expect(wrapper.find('.review-draft-panel-wrapper').exists()).toBe(true)
    expect(wrapper.find('.diff-file-list-wrapper').exists()).toBe(false)
    await clickButton('Checklist')
    expect(wrapper.find('.review-draft-panel-wrapper').exists()).toBe(false)
    expect(wrapper.find('.diff-criteria-rail').exists()).toBe(true)
    expect(localStorage.getItem('kobo:diff:fileTree')).toBe('1')
    expect(localStorage.getItem('kobo:diff:criteriaRail')).toBe('1')
  })

  it('opens mobile code after selection and retains the same dirty editor across panels', async () => {
    screen.lt.sm = screen.lt.md = true
    await mountWithFiles()
    await selectFile()
    expect(wrapper.find('.diff-file-list-wrapper').exists()).toBe(false)
    expect(wrapper.find('.diff-editor-column').attributes('style') ?? '').not.toContain('display: none')
    const modified = editorMock.models[1]!
    modified.value = 'unsaved edit'
    modified.change()
    await flushPromises()
    expect(wrapper.find('.diff-save-bar').text()).toContain('Unsaved changes')
    await clickButton('Files')
    expect(wrapper.find('.diff-editor-column').attributes('style')).toContain('display: none')
    await clickButton('Code')
    expect(editorMock.create).toHaveBeenCalledTimes(1)
    expect(editorMock.dispose).not.toHaveBeenCalled()
    expect(modified.value).toBe('unsaved edit')
    expect(editToggle().props('options')[1].disable).toBe(true)
    await clickButton(en['tooltip.closeDiffViewer'])
    expect(wrapper.findAllComponents({ name: 'QDialog' }).some((dialog) => dialog.props('modelValue'))).toBe(true)
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('navigates files and changes, preserving a dirty file when navigation is cancelled', async () => {
    await mountWithFiles()
    await clickButton('Next file')
    expect(wrapper.find('.diff-current-file').text()).toBe('src/a.ts')
    await clickButton('Next change')
    expect(editorMock.goToDiff).toHaveBeenCalledWith('next')
    const modified = editorMock.models[1]!
    modified.value = 'unsaved'
    modified.change()
    await flushPromises()
    await clickButton('Next file')
    expect(dialog).toHaveBeenCalled()
    expect(wrapper.find('.diff-current-file').text()).toBe('src/a.ts')
    expect(editorMock.create).toHaveBeenCalledTimes(1)
  })

  it('returns to the same selected file from the mobile tree without recreating Monaco', async () => {
    screen.lt.sm = screen.lt.md = true
    await mountWithFiles()
    await selectFile()
    await clickButton('Files')
    wrapper.findComponent({ name: 'QTree' }).vm.$emit('update:selected', null)
    await flushPromises()
    expect(wrapper.find('.diff-file-list-wrapper').exists()).toBe(false)
    expect(wrapper.find('.diff-current-file').attributes('title')).toBe('src/a.ts')
    expect(editorMock.create).toHaveBeenCalledTimes(1)
  })

  it('reserves the actual comment height and keeps comments reachable in collapsed code', async () => {
    await mountWithFiles(true)
    await selectFile()
    await clickButton('Add comment')
    expect(editorMock.zones[0]?.showInHiddenAreas).toBe(true)
    wrapper.findComponent({ name: 'ReviewCommentBlock' }).vm.$emit('resize', { width: 300, height: 320 })
    await flushPromises()
    expect(editorMock.zones[0]?.heightInPx).toBe(320)
    expect(editorMock.layoutZone).toHaveBeenCalledWith('zone-1')
    expect(wrapper.find('.review-zone-overlay').attributes('style')).toContain('height: 320px')
  })

  it('changes responsive editor options without recreating its models', async () => {
    await mountWithFiles()
    await selectFile()
    const layout = wrapper
      .findAllComponents({ name: 'QBtnToggle' })
      .find((c) => c.props('options').some((o: { value: string }) => o.value === 'side'))!
    layout.vm.$emit('update:modelValue', 'side')
    await flushPromises()
    expect(editorMock.updateOptions).toHaveBeenLastCalledWith(expect.objectContaining({ renderSideBySide: true }))
    screen.lt.sm = screen.lt.md = true
    await flushPromises()
    expect(editorMock.updateOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ renderSideBySide: false, wordWrap: 'on' }),
    )
    expect(editorMock.create).toHaveBeenCalledTimes(1)
    expect(layout.props('options').find((o: { value: string }) => o.value === 'side').disable).toBe(true)
  })

  it('opens and closes the review draft on desktop without hiding the code', async () => {
    await mountWithFiles(true)
    expect(wrapper.find('.review-draft-panel-wrapper').exists()).toBe(false)
    await clickButton('Comments · 0')
    expect(wrapper.find('.review-draft-panel-wrapper').exists()).toBe(true)
    expect(wrapper.find('.diff-editor-column').attributes('style') ?? '').not.toContain('display: none')
    await clickButton('Comments · 0')
    expect(wrapper.find('.review-draft-panel-wrapper').exists()).toBe(false)
  })
})
