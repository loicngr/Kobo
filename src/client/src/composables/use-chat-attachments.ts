import { computed, type Ref, ref } from 'vue'
import { type AttachmentError, attachmentFormat, validateAttachments } from '../../../shared/attachments'

export interface PendingAttachment {
  tempId: string
  workspaceId: string
  uid?: string
  path?: string
  kind: 'image' | 'file'
  originalName: string
  type: string
  size: number
  placeholder: string
  reference?: string
  status: 'uploading' | 'ready' | 'error'
}

export function useChatAttachments(options: {
  message: Ref<string>
  workspaceId: () => string
  locked: () => boolean
  insert: (text: string) => void
  uploadingLabel: () => string
  notify: (error: AttachmentError | 'upload') => void
}) {
  const pending = ref<PendingAttachment[]>([])
  const blocked = computed(() => pending.value.some((file) => file.status !== 'ready'))
  let queue = Promise.resolve()
  let sequence = 0

  async function cleanup(file: PendingAttachment) {
    if (!file.uid || !file.path) return
    const endpoint =
      file.kind === 'image'
        ? `images/${encodeURIComponent(file.uid)}`
        : `attachments/${encodeURIComponent(file.path.split('/').pop()!)}`
    await fetch(`/api/workspaces/${encodeURIComponent(file.workspaceId)}/${endpoint}`, { method: 'DELETE' }).catch(
      () => {},
    )
  }

  async function upload(entry: PendingAttachment, file: File) {
    if (!pending.value.some((item) => item.tempId === entry.tempId)) return
    try {
      const body = new FormData()
      body.append('attachment', file)
      const response = await fetch(`/api/workspaces/${encodeURIComponent(entry.workspaceId)}/attachments`, {
        method: 'POST',
        body,
      })
      if (!response.ok) throw new Error('Upload failed')
      const data = (await response.json()) as { uid: string; path: string; kind: 'image' | 'file'; reference: string }
      const current = pending.value.find((item) => item.tempId === entry.tempId)
      if (!current) {
        await cleanup({ ...entry, ...data })
        return
      }
      options.message.value = options.message.value.split(current.placeholder).join(data.reference)
      Object.assign(current, {
        uid: data.uid,
        path: data.path,
        kind: data.kind,
        placeholder: `[${data.kind}: ${data.path}]`,
        reference: data.reference,
        status: 'ready',
      })
    } catch {
      const current = pending.value.find((item) => item.tempId === entry.tempId)
      if (current) {
        current.status = 'error'
        options.notify('upload')
      }
    }
  }

  function addFiles(files: File[]): Promise<void> {
    if (options.locked() || files.length === 0) return Promise.resolve()
    const error = validateAttachments([
      ...pending.value.map((file) => ({ name: file.originalName, type: file.type, size: file.size })),
      ...files,
    ])
    if (error) {
      options.notify(error)
      return Promise.resolve()
    }
    for (const file of files) {
      const kind = attachmentFormat(file)!.kind
      const entry: PendingAttachment = {
        tempId: crypto.randomUUID(),
        workspaceId: options.workspaceId(),
        kind,
        originalName: file.name,
        type: file.type,
        size: file.size,
        placeholder: `[${kind}: ${options.uploadingLabel()} ${++sequence}]`,
        status: 'uploading',
      }
      pending.value.push(entry)
      options.insert(`${entry.placeholder} `)
      // Serialize a draft's uploads to avoid contention on the server's lifecycle guard.
      queue = queue.then(() => upload(entry, file))
    }
    return queue
  }

  function remove(tempId: string) {
    const file = pending.value.find((item) => item.tempId === tempId)
    if (!file) return
    pending.value = pending.value.filter((item) => item.tempId !== tempId)
    if (file.reference) options.message.value = options.message.value.split(file.reference).join('')
    options.message.value = options.message.value.split(file.placeholder).join('')
    queue = queue.then(() => cleanup(file))
  }

  function reconcile() {
    for (const file of [...pending.value]) {
      if (!options.message.value.includes(file.placeholder)) remove(file.tempId)
    }
  }

  /** Transfer ownership to the sent/queued message; keep its files on disk. */
  function take(): PendingAttachment[] {
    const files = pending.value
    pending.value = []
    return files
  }

  function restore(files: PendingAttachment[]) {
    pending.value = [...files.filter((file) => file.workspaceId === options.workspaceId()), ...pending.value]
  }

  function discard() {
    for (const file of take()) queue = queue.then(() => cleanup(file))
    // An in-flight upload no longer finds its entry and cleans up its receipt.
  }

  return { pending, blocked, addFiles, remove, reconcile, take, restore, discard }
}
