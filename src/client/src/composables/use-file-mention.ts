import { fuzzyRank } from 'src/utils/fuzzy-match'
import { computed, type Ref, ref, watch } from 'vue'

/**
 * Stateful logic for the `@<fragment>` file-path autocomplete in the chat input.
 * Mirrors `useSlashAutocomplete` but sources its entries from the workspace's
 * worktree (`/api/git/files`) and ranks them with an fzf-style fuzzy match.
 *
 * @param message         reactive ref bound to the input's textual value
 * @param getInputEl      accessor for the live `<textarea>` (for caret position)
 * @param getWorktreePath accessor for the current workspace's worktree path
 */
export function useFileMention(
  message: Ref<string>,
  getInputEl: () => HTMLTextAreaElement | HTMLInputElement | null,
  getWorktreePath: () => string | null,
) {
  const files = ref<string[]>([])
  const showFiles = ref(false)
  const fileFilter = ref('')
  const selectedFileIndex = ref(0)
  let lastFetchPath = ''
  let lastFetch = 0

  async function fetchFiles(): Promise<void> {
    const wt = getWorktreePath()
    if (!wt) return
    const now = Date.now()
    // Re-fetch when the worktree changed, or after a 5s throttle window.
    if (wt === lastFetchPath && now - lastFetch < 5000 && files.value.length > 0) return
    lastFetchPath = wt
    lastFetch = now
    try {
      const res = await fetch(`/api/git/files?path=${encodeURIComponent(wt)}`)
      if (res.ok) {
        const body = (await res.json()) as { files?: string[] }
        files.value = Array.isArray(body.files) ? body.files : []
      }
    } catch {
      /* network errors are not fatal — popup just stays empty */
    }
  }

  /**
   * The `@<fragment>` token immediately before the caret, or null. The `@` must
   * start the input or follow whitespace so e-mail addresses don't trigger it.
   */
  function getMentionFragmentBeforeCaret(): string | null {
    const el = getInputEl()
    if (!el) return null
    const caret = el.selectionStart ?? message.value.length
    const before = message.value.slice(0, caret)
    const match = before.match(/(?:^|\s)@([\w./-]*)$/)
    return match ? match[1] : null
  }

  /** Re-evaluate popup visibility from the current caret + message text. */
  async function detectMentionFragment(): Promise<void> {
    const fragment = getMentionFragmentBeforeCaret()
    if (fragment !== null) {
      await fetchFiles()
      fileFilter.value = fragment
      showFiles.value = true
      selectedFileIndex.value = 0
    } else {
      showFiles.value = false
    }
  }

  function closeDropdown(): void {
    showFiles.value = false
  }

  /** Replace the `@<fragment>` before the caret with `filePath` (+ a space). */
  function replaceFragmentWith(filePath: string): void {
    const el = getInputEl()
    if (!el) return
    const caret = el.selectionStart ?? message.value.length
    const before = message.value.slice(0, caret)
    const after = message.value.slice(caret)
    const match = before.match(/(?:^|\s)@[\w./-]*$/)
    if (!match) return
    // The regex may have consumed a leading whitespace — keep it.
    const lead = match[0].startsWith('@') ? '' : match[0][0]
    const fragmentStart = (match.index ?? caret) + lead.length
    message.value = `${message.value.slice(0, fragmentStart)}${filePath} ${after}`
    closeDropdown()
  }

  /** Fuzzy-ranked file matches, capped for popup rendering. */
  const fileMatches = computed<string[]>(() => fuzzyRank(fileFilter.value, files.value).slice(0, 50))

  // Keep the selection index inside bounds when the filter shrinks the list.
  watch(
    () => fileMatches.value.length,
    (len) => {
      if (len === 0) {
        selectedFileIndex.value = 0
        return
      }
      if (selectedFileIndex.value >= len) {
        selectedFileIndex.value = len - 1
      }
    },
  )

  return {
    showFiles,
    fileMatches,
    selectedFileIndex,
    detectMentionFragment,
    replaceFragmentWith,
    closeDropdown,
  }
}
