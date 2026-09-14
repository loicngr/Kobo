import { afterEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useChatAttachments } from '../composables/use-chat-attachments'

afterEach(() => vi.unstubAllGlobals())
function setup() {
  const message = ref('')
  const workspace = ref('a')
  const locked = ref(false)
  const notify = vi.fn()
  const uploads = useChatAttachments({
    message,
    workspaceId: () => workspace.value,
    locked: () => locked.value,
    insert: (text) => {
      message.value += text
    },
    uploadingLabel: () => 'Uploading',
    notify,
  })
  return { ...uploads, message, workspace, locked, notify }
}
const file = () => new File(['# Brief'], 'brief.md')
const receipt = () =>
  Response.json({
    uid: '0123456789',
    kind: 'file',
    path: '.ai/attachments/0123456789.md',
    reference: 'Attached document "brief.md": [file: .ai/attachments/0123456789.md]',
  })

it('keeps the file when its surrounding label is edited and removes it only with its path token', async () => {
  const fetchMock = vi.fn().mockImplementation(async () => receipt())
  vi.stubGlobal('fetch', fetchMock)
  const state = setup()
  await state.addFiles([file()])
  state.message.value = 'Consulte ce fichier : [file: .ai/attachments/0123456789.md]'
  state.reconcile()
  expect(state.pending.value).toHaveLength(1)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  state.remove(state.pending.value[0]!.tempId)
  await Promise.resolve()
  expect(state.message.value).toBe('Consulte ce fichier : ')
  expect(fetchMock).toHaveBeenLastCalledWith('/api/workspaces/a/attachments/0123456789.md', { method: 'DELETE' })
})

it('uploads a document, replaces its placeholder and retains it when handed to a sent message', async () => {
  const fetchMock = vi.fn().mockResolvedValue(receipt())
  vi.stubGlobal('fetch', fetchMock)
  const state = setup()
  await state.addFiles([file()])
  expect(fetchMock.mock.calls[0]![0]).toBe('/api/workspaces/a/attachments')
  expect(fetchMock.mock.calls[0]![1].body.get('attachment').name).toBe('brief.md')
  expect(state.message.value).toContain('[file: .ai/attachments/0123456789.md]')
  expect(state.blocked.value).toBe(false)
  const transferred = state.take()
  state.message.value = ''
  state.reconcile()
  expect(transferred).toHaveLength(1)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('cleans a late upload using the original workspace after discard and navigation', async () => {
  let finish!: (value: Response) => void
  const fetchMock = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    )
    .mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
  const state = setup()
  const upload = state.addFiles([file()])
  await Promise.resolve()
  state.discard()
  state.workspace.value = 'b'
  state.message.value = 'New workspace draft'
  finish(receipt())
  await upload
  expect(state.message.value).toBe('New workspace draft')
  expect(fetchMock).toHaveBeenLastCalledWith('/api/workspaces/a/attachments/0123456789.md', { method: 'DELETE' })
})

it('keeps failed uploads blocking send until removed and reports validation errors', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  const state = setup()
  await state.addFiles([file()])
  expect(state.blocked.value).toBe(true)
  state.remove(state.pending.value[0]!.tempId)
  expect(state.blocked.value).toBe(false)
  await state.addFiles([new File(['script'], 'script.sh')])
  expect(state.notify).toHaveBeenLastCalledWith('type')
  expect(state.pending.value).toEqual([])
})

it('serializes uploads and applies count limits across the whole draft', async () => {
  let finish!: (value: Response) => void
  const fetchMock = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    )
    .mockImplementation(async () => receipt())
  vi.stubGlobal('fetch', fetchMock)
  const state = setup()
  const upload = state.addFiles([file(), file()])
  await Promise.resolve()
  expect(state.pending.value).toHaveLength(2)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  await state.addFiles(Array.from({ length: 9 }, file))
  expect(state.notify).toHaveBeenLastCalledWith('count')
  finish(receipt())
  await upload
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('preserves handed-off attachments on discard and restores their badges after send failure', async () => {
  const fetchMock = vi.fn().mockImplementation(async () => receipt())
  vi.stubGlobal('fetch', fetchMock)
  const state = setup()
  await state.addFiles([file()])
  const sent = state.take()
  state.discard()
  expect(fetchMock).toHaveBeenCalledTimes(1)
  state.restore(sent)
  expect(state.pending.value).toHaveLength(1)
  state.remove(sent[0]!.tempId)
  await Promise.resolve()
  expect(fetchMock).toHaveBeenLastCalledWith('/api/workspaces/a/attachments/0123456789.md', { method: 'DELETE' })
})

it('serializes removal behind an in-flight upload to avoid lifecycle conflicts', async () => {
  let finish!: (value: Response) => void
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(receipt())
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    )
    .mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
  const state = setup()
  await state.addFiles([file()])
  const first = state.pending.value[0]!.tempId
  const second = state.addFiles([file()])
  await Promise.resolve()
  state.remove(first)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  finish(receipt())
  await second
  await Promise.resolve()
  expect(fetchMock).toHaveBeenCalledTimes(3)
})
