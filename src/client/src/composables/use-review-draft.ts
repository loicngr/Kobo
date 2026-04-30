import { type Ref, ref } from 'vue'

export interface ReviewComment {
  id: string
  filePath: string
  line: number
  content: string
  createdAt: string
}

export interface ReviewDraft {
  comments: ReviewComment[]
  globalMessage: string
}

export interface CreateReviewCommentInput {
  filePath: string
  line: number
  content: string
}

export function createReviewComment(input: CreateReviewCommentInput): ReviewComment {
  if (!input.filePath || input.filePath.startsWith('/')) {
    throw new Error('Invalid filePath: must be non-empty POSIX path relative to workspace root')
  }
  return {
    id: crypto.randomUUID(),
    filePath: input.filePath,
    line: input.line,
    content: input.content,
    createdAt: new Date().toISOString(),
  }
}

function indentMultiLine(content: string): string {
  const lines = content.split('\n')
  if (lines.length === 1) return content
  return lines.map((line, i) => (i === 0 ? line : `    ${line}`)).join('\n')
}

export function formatSubmitMessage(draft: ReviewDraft): string {
  const { comments, globalMessage } = draft

  if (comments.length === 0) {
    return `## Code review\n\n${globalMessage}`
  }

  const byFile = new Map<string, ReviewComment[]>()
  for (const c of comments) {
    const list = byFile.get(c.filePath) ?? []
    list.push(c)
    byFile.set(c.filePath, list)
  }
  for (const list of byFile.values()) {
    list.sort((a, b) => a.line - b.line || a.createdAt.localeCompare(b.createdAt))
  }
  const sortedFiles = Array.from(byFile.keys()).sort()

  const sections = sortedFiles.map((filePath) => {
    const list = byFile.get(filePath) as ReviewComment[]
    const bullets = list.map((c) => `- **L${c.line}** : ${indentMultiLine(c.content)}`).join('\n')
    return `### \`${filePath}\`\n\n${bullets}`
  })

  const fileCount = sortedFiles.length
  const footer = `_${comments.length} comment${comments.length === 1 ? '' : 's'} across ${fileCount} file${fileCount === 1 ? '' : 's'}. Address them and ping me back when done._`

  const header = '## Code review — please address the following'
  const intro = globalMessage ? `\n\n${globalMessage}` : ''
  return `${header}${intro}\n\n${sections.join('\n\n')}\n\n---\n${footer}`
}

const DEBOUNCE_MS = 300

function storageKey(workspaceId: string): string {
  return `kobo:review-draft:${workspaceId}`
}

function readDraft(workspaceId: string): ReviewDraft {
  const raw = localStorage.getItem(storageKey(workspaceId))
  if (!raw) return { comments: [], globalMessage: '' }
  try {
    const parsed = JSON.parse(raw) as ReviewDraft
    return {
      comments: Array.isArray(parsed.comments) ? parsed.comments : [],
      globalMessage: typeof parsed.globalMessage === 'string' ? parsed.globalMessage : '',
    }
  } catch {
    return { comments: [], globalMessage: '' }
  }
}

export interface UseReviewDraftDeps {
  sendChatMessage: (workspaceId: string, content: string, sessionId?: string) => Promise<void> | void
}

export interface SubmitResult {
  ok: boolean
  error?: string
}

export interface UseReviewDraft {
  draft: Ref<ReviewDraft>
  addComment(input: CreateReviewCommentInput): ReviewComment
  updateComment(id: string, content: string): void
  deleteComment(id: string): void
  setGlobalMessage(value: string): void
  clearDraft(): void
  flush(): void
  submit(sessionId?: string): Promise<SubmitResult>
}

export function useReviewDraft(workspaceId: string, deps: UseReviewDraftDeps): UseReviewDraft {
  const draft = ref<ReviewDraft>(readDraft(workspaceId))
  let pendingTimer: ReturnType<typeof setTimeout> | null = null

  function persistSoon() {
    if (pendingTimer !== null) clearTimeout(pendingTimer)
    pendingTimer = setTimeout(() => {
      pendingTimer = null
      try {
        localStorage.setItem(storageKey(workspaceId), JSON.stringify(draft.value))
      } catch (err) {
        console.warn('[review-draft] persist failed:', err)
      }
    }, DEBOUNCE_MS)
  }

  function flush() {
    if (pendingTimer === null) return
    clearTimeout(pendingTimer)
    pendingTimer = null
    try {
      localStorage.setItem(storageKey(workspaceId), JSON.stringify(draft.value))
    } catch (err) {
      console.warn('[review-draft] flush failed:', err)
    }
  }

  function addComment(input: CreateReviewCommentInput): ReviewComment {
    const c = createReviewComment(input)
    draft.value.comments.push(c)
    persistSoon()
    return c
  }

  function updateComment(id: string, content: string) {
    const c = draft.value.comments.find((x) => x.id === id)
    if (c) {
      c.content = content
      persistSoon()
    }
  }

  function deleteComment(id: string) {
    draft.value.comments = draft.value.comments.filter((x) => x.id !== id)
    persistSoon()
  }

  function setGlobalMessage(value: string) {
    draft.value.globalMessage = value
    persistSoon()
  }

  function clearDraft() {
    draft.value = { comments: [], globalMessage: '' }
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
    localStorage.removeItem(storageKey(workspaceId))
  }

  async function submit(sessionId?: string): Promise<SubmitResult> {
    if (draft.value.comments.length === 0 && draft.value.globalMessage.trim() === '') {
      return { ok: false, error: 'Draft is empty' }
    }
    flush()
    const payload = formatSubmitMessage(draft.value)
    try {
      await deps.sendChatMessage(workspaceId, payload, sessionId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
    clearDraft()
    return { ok: true }
  }

  return { draft, addComment, updateComment, deleteComment, setGlobalMessage, clearDraft, flush, submit }
}
