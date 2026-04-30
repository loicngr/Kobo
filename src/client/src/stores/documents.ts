import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface DocumentFile {
  path: string
  name: string
  modifiedAt: string
}

export interface DocumentContent {
  path: string
  name: string
  content: string
}

/**
 * Documents panel state. Kept in a shared store (rather than local to the
 * panel) so other parts of the UI — e.g. clickable paths in chat messages —
 * can ask the panel to open a specific document via `openDocumentByPath`,
 * which also bumps `requestOpen` so the layout can switch to the
 * Documents tab.
 */
export const useDocumentsStore = defineStore('documents', () => {
  const documentsByWorkspace = ref<Record<string, DocumentFile[]>>({})
  const loadingList = ref(false)
  const loadingContent = ref(false)
  const selected = ref<DocumentContent | null>(null)
  const requestOpen = ref(0)

  function documentsFor(workspaceId: string): DocumentFile[] {
    return documentsByWorkspace.value[workspaceId] ?? []
  }

  async function fetchDocuments(workspaceId: string): Promise<void> {
    loadingList.value = true
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/documents`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as { documents: DocumentFile[] }
      documentsByWorkspace.value[workspaceId] = body.documents
    } catch (err) {
      console.error('[documents-store] fetchDocuments failed:', err)
      documentsByWorkspace.value[workspaceId] = []
    } finally {
      loadingList.value = false
    }
  }

  async function openDocument(workspaceId: string, file: DocumentFile): Promise<void> {
    loadingContent.value = true
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/document?path=${encodeURIComponent(file.path)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as { content: string; path: string }
      selected.value = { path: body.path, name: file.name, content: body.content }
    } catch (err) {
      console.error('[documents-store] openDocument failed:', err)
      throw err
    } finally {
      loadingContent.value = false
    }
  }

  /**
   * Resolve a path against the current list and open it. Used by external
   * deep-links (clickable paths in chat messages). If the path is not in
   * the known list, the call refreshes the list and retries once.
   */
  async function openDocumentByPath(workspaceId: string, filePath: string): Promise<boolean> {
    const findInList = () => (documentsByWorkspace.value[workspaceId] ?? []).find((d) => d.path === filePath) ?? null
    let entry = findInList()
    if (!entry) {
      await fetchDocuments(workspaceId)
      entry = findInList()
    }
    if (!entry) return false
    await openDocument(workspaceId, entry)
    requestOpen.value++
    return true
  }

  function closeDocument(): void {
    selected.value = null
  }

  function clearForWorkspace(workspaceId: string): void {
    delete documentsByWorkspace.value[workspaceId]
    selected.value = null
  }

  return {
    documentsByWorkspace,
    loadingList,
    loadingContent,
    selected,
    requestOpen,
    documentsFor,
    fetchDocuments,
    openDocument,
    openDocumentByPath,
    closeDocument,
    clearForWorkspace,
  }
})
