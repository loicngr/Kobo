export interface DiffLine {
  type: 'add' | 'del' | 'context'
  content: string
}

/**
 * Above this many changed lines on either side, the quadratic LCS table would
 * allocate tens of megabytes and block the main thread. 800 caps the flat
 * Int32Array at 801 × 801 × 4 ≈ 2.5 MB.
 */
export const INLINE_DIFF_MAX_LINES = 800

/**
 * Compute a line-by-line diff using the Longest Common Subsequence algorithm.
 * Shared lines become `context`, differing lines are split into `del` (from
 * `oldText`) and `add` (from `newText`).
 *
 * The common prefix and suffix are trimmed first: a three-line edit inside a
 * two-thousand-line file collapses to a three-by-three table instead of a
 * two-thousand-square one. Past INLINE_DIFF_MAX_LINES of remaining difference
 * the LCS walk is skipped entirely and the change is rendered as a wholesale
 * replacement — which is what a reviewer gets from `git diff` on a rewrite
 * anyway, and what this UI showed after freezing the tab for a second.
 */
export function computeInlineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n')
  const b = newText.split('\n')

  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  const head: DiffLine[] = a.slice(0, start).map((content) => ({ type: 'context', content }))
  const tail: DiffLine[] = a.slice(endA).map((content) => ({ type: 'context', content }))
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)

  if (midA.length > INLINE_DIFF_MAX_LINES || midB.length > INLINE_DIFF_MAX_LINES) {
    return [
      ...head,
      ...midA.map((content): DiffLine => ({ type: 'del', content })),
      ...midB.map((content): DiffLine => ({ type: 'add', content })),
      ...tail,
    ]
  }

  return [...head, ...lcsDiff(midA, midB), ...tail]
}

/** LCS walk over two already-trimmed, already-bounded line lists. */
function lcsDiff(a: readonly string[], b: readonly string[]): DiffLine[] {
  const m = a.length
  const n = b.length
  if (m === 0 && n === 0) return []
  if (m === 0) return b.map((content) => ({ type: 'add', content }))
  if (n === 0) return a.map((content) => ({ type: 'del', content }))

  const width = n + 1
  // One flat typed array instead of (m+1) JavaScript arrays: same values,
  // a quarter of the memory and no per-row allocation.
  const lcs = new Int32Array((m + 1) * width)
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + (j + 1)] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + (j + 1)])
    }
  }

  const result: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      result.push({ type: 'context', content: a[i] })
      i++
      j++
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + (j + 1)]) {
      result.push({ type: 'del', content: a[i] })
      i++
    } else {
      result.push({ type: 'add', content: b[j] })
      j++
    }
  }
  while (i < m) result.push({ type: 'del', content: a[i++] })
  while (j < n) result.push({ type: 'add', content: b[j++] })
  return result
}

export interface FileChangeInfo {
  toolName: 'Edit' | 'Write' | 'Bash:rm'
  filePath: string
  oldString?: string
  newString?: string
  content?: string
  replaceAll?: boolean
  additions: number
  deletions: number
  /** Pre-parsed diff, populated when the source already gave us a unified diff. */
  diffLines?: DiffLine[]
}

/**
 * Parse a unified-diff blob into a flat `DiffLine[]`.
 * Hunk headers and file headers are dropped; untagged lines fall back to `context`.
 */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines = diff.split('\n')
  const result: DiffLine[] = []
  // Les en-têtes `---` / `+++` n'existent QUE dans le préambule, avant le
  // premier `@@`. Les tester inconditionnellement effaçait toute ligne
  // supprimée commençant par deux tirets — commentaire SQL, séparateur
  // Markdown ou YAML, décrémentation en C — qui disparaissait purement et
  // simplement du rendu. On ne les reconnaît donc que tant qu'aucun bloc n'a
  // commencé.
  let inHunk = false
  for (const line of lines) {
    if (line.startsWith('@@')) {
      inHunk = true
      continue
    }
    if (!inHunk && (line.startsWith('+++') || line.startsWith('---'))) continue
    if (line.startsWith('+')) {
      result.push({ type: 'add', content: line.slice(1) })
    } else if (line.startsWith('-')) {
      result.push({ type: 'del', content: line.slice(1) })
    } else if (line.startsWith(' ')) {
      result.push({ type: 'context', content: line.slice(1) })
    } else if (line.length > 0) {
      result.push({ type: 'context', content: line })
    }
  }
  return result
}

/**
 * Extract file-change metadata from a `tool:call` input. Returns `null` if
 * the tool is not a file-mutating one (Edit, Write, or Bash with rm).
 */
export function getFileChangeInfo(toolName: string, input: unknown): FileChangeInfo | null {
  if (!input || typeof input !== 'object') return null
  const rec = input as Record<string, unknown>

  if (toolName === 'Edit') {
    const filePath = rec.file_path as string | undefined
    if (!filePath) return null
    const oldStr = (rec.old_string as string) ?? ''
    const newStr = (rec.new_string as string) ?? ''
    const unifiedDiff = typeof rec.diff === 'string' ? rec.diff : ''
    if (!oldStr && !newStr && unifiedDiff.length > 0) {
      const parsed = parseUnifiedDiff(unifiedDiff)
      return {
        toolName: 'Edit',
        filePath,
        additions: parsed.filter((l) => l.type === 'add').length,
        deletions: parsed.filter((l) => l.type === 'del').length,
        diffLines: parsed,
      }
    }
    return {
      toolName: 'Edit',
      filePath,
      oldString: oldStr,
      newString: newStr,
      replaceAll: (rec.replace_all as boolean) ?? false,
      additions: newStr ? newStr.split('\n').length : 0,
      deletions: oldStr ? oldStr.split('\n').length : 0,
    }
  }

  if (toolName === 'Write') {
    const filePath = rec.file_path as string | undefined
    if (!filePath) return null
    const content = (rec.content as string) ?? ''
    return {
      toolName: 'Write',
      filePath,
      content,
      additions: content ? content.split('\n').length : 0,
      deletions: 0,
    }
  }

  if (toolName === 'Bash') {
    const cmd = (rec.command as string) ?? ''
    const rmMatch = cmd.match(/^\s*rm\s+(?:-[a-zA-Z]*\s+)*(.+)/)
    if (rmMatch) {
      const filePath = rmMatch[1].trim().replace(/["']/g, '')
      return {
        toolName: 'Bash:rm',
        filePath,
        additions: 0,
        deletions: 1,
      }
    }
  }

  return null
}
